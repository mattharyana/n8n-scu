#!/usr/bin/env python3
"""Generate local secrets, start the stack, and import built-in n8n workflows."""
import argparse
import json
import re
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
def run(*args):
    subprocess.run(args,cwd=ROOT,check=True)
def compose(*args): run('docker','compose',*args)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--publish',action='store_true',help='Publish the interview and Gemini voice workflows.')
    ap.add_argument('--port',type=int,default=5678)
    ap.add_argument('--provider',choices=['gemini','openai'],help='Select the interview/evaluation provider; local embeddings and Gemini voice stay independent.')
    ap.add_argument('--model',help='Chat model ID for the selected provider; applied to interview and evaluation.')
    args=ap.parse_args()
    configfile=ROOT/'model-config.json'
    config=json.loads(configfile.read_text())
    provider=args.provider or config['provider']
    if args.model:
        model=args.model.removeprefix('models/')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}',model):
            raise SystemExit('Use a valid model ID without a URL, spaces, or API key.')
        config['chat_models'][provider]=('models/' if provider=='gemini' else '')+model
    config['provider']=provider
    configfile.write_text(json.dumps(config,indent=2)+'\n')
    envfile=ROOT/'.env'
    if not envfile.exists():
        envfile.write_text(f'POSTGRES_PASSWORD={secrets.token_hex(24)}\nN8N_ENCRYPTION_KEY={secrets.token_hex(32)}\nN8N_PORT={args.port}\n')
        envfile.chmod(0o600)
    env=dict(line.split('=',1) for line in envfile.read_text().splitlines() if line and not line.startswith('#'))
    runtime=ROOT/'.runtime'
    runtime.mkdir(exist_ok=True,mode=0o700)
    # Secrets are only in a local, ignored import file and n8n's encrypted store.
    credentials=[{'id':'mockInterviewPostgres','name':'Interview Postgres','type':'postgres','data':{
        'host':'postgres','database':'interview','user':'interview','password':env['POSTGRES_PASSWORD'],
        'port':5432,'ssl':'disable','allowUnauthorizedCerts':False}}]
    credentialfile=runtime/'postgres.json'
    credentialfile.write_text(json.dumps(credentials))
    credentialfile.chmod(0o600)
    run('python3','scripts/build_workflows.py')
    compose('config','--quiet')
    compose('up','-d')
    port=env.get('N8N_PORT','5678')
    for _ in range(90):
        try:
            with urllib.request.urlopen(f'http://localhost:{port}/healthz/readiness',timeout=2) as r:
                if r.status==200: break
        except Exception: time.sleep(1)
    else: raise SystemExit('n8n did not become ready. Run: docker compose logs --tail=80 n8n')
    # Apply idempotent schema upgrades to existing installations as well as new ones.
    compose('exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','interview','-d','interview','-f','/docker-entrypoint-initdb.d/01-schema.sql')
    compose('exec','-T','n8n','n8n','import:credentials','--input=/import/runtime/postgres.json')
    # Import a placeholder once; reruns must never overwrite the user's API key.
    if not (runtime/'openai-imported').exists():
        aifile=runtime/'openai-initial.json'
        aifile.write_text(json.dumps([{'id':'mockInterviewOpenAI','name':'Interview OpenAI - add API key','type':'openAiApi','data':{'apiKey':'ADD_YOUR_API_KEY_IN_N8N','url':'https://api.openai.com/v1'}}]))
        aifile.chmod(0o600)
        compose('exec','-T','n8n','n8n','import:credentials','--input=/import/runtime/openai-initial.json')
        (runtime/'openai-imported').touch(mode=0o600)
        aifile.unlink()
    if not (runtime/'gemini-imported').exists():
        geminifile=runtime/'gemini-initial.json'
        geminifile.write_text(json.dumps([{'id':'mockInterviewGemini','name':'Interview Gemini - add API key','type':'googlePalmApi','data':{'apiKey':'ADD_YOUR_GEMINI_API_KEY_IN_N8N','host':'https://generativelanguage.googleapis.com'}}]))
        geminifile.chmod(0o600)
        compose('exec','-T','n8n','n8n','import:credentials','--input=/import/runtime/gemini-initial.json')
        (runtime/'gemini-imported').touch(mode=0o600)
        geminifile.unlink()
    if not (runtime/'local-embeddings-imported').exists():
        localfile=runtime/'local-embeddings-initial.json'
        localfile.write_text(json.dumps([{'id':'mockInterviewLocalEmbeddings','name':'Interview local embeddings','type':'openAiApi','data':{'apiKey':'local-only','url':'http://embeddings:8000/v1'}}]))
        localfile.chmod(0o600)
        compose('exec','-T','n8n','n8n','import:credentials','--input=/import/runtime/local-embeddings-initial.json')
        (runtime/'local-embeddings-imported').touch(mode=0o600)
        localfile.unlink()
    compose('exec','-T','n8n','n8n','import:workflow','--separate','--input=/import/workflows')
    if args.publish:
        for workflow in ['interviewIngest','interviewChat','interviewReview','interviewVoiceTranscribe','interviewVoiceSpeak']:
            compose('exec','-T','n8n','n8n','publish:workflow',f'--id={workflow}')
        compose('restart','n8n')
    status='The five workflows are published.' if args.publish else 'Publish the Interview workflows after adding the key.'
    credential='Interview Gemini - add API key' if provider=='gemini' else 'Interview OpenAI - add API key'
    print(f'\nn8n workspace: http://localhost:{port}/home/workflows\nSelected provider: {provider}; chat model: {config["chat_models"][provider]}\nCredentials: http://localhost:{port}/home/credentials\nOpen {credential}, enter your API key, and click Save.\nThe /assistant Connect a model screen is a separate optional n8n feature.\n{status}\nMaterial form: http://localhost:{port}/form/interview-materials\nVoice portal: http://localhost:{env.get("PORTAL_PORT","5677")}\nOriginal text chat: http://localhost:{port}/webhook/mock-interview-chat/chat')

if __name__=='__main__': main()
