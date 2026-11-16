#!/usr/bin/env python3
"""Run real n8n + pgvector against an isolated deterministic model double.
Uses a separate Compose project, port, credentials, database, and Docker volumes.
No OpenAI key or external API requests are used. Leave production data untouched.
"""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request
import urllib.parse
import uuid
import io
import zipfile

ROOT=Path(__file__).resolve().parents[1]
DC=['docker','compose','--env-file','.runtime/test.env','-p','mock-interview-test','-f','compose.yaml','-f','tests/compose.test.yaml']
BASE='http://localhost:5679'
class LocalFormRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if code in (307,308) and req.get_method()=='POST':
            if urllib.parse.urlsplit(newurl).netloc!=urllib.parse.urlsplit(BASE).netloc:
                raise RuntimeError('Refusing a form redirect outside the local test server')
            return urllib.request.Request(newurl,data=b'{}',headers={'Content-Type':'application/json'})
        return super().redirect_request(req,fp,code,msg,headers,newurl)
def docker(*args,input=None):
    r=subprocess.run(DC+list(args),cwd=ROOT,input=input,text=True,capture_output=True)
    if r.returncode: raise RuntimeError(r.stdout+'\n'+r.stderr)
    return r.stdout
def sql(q): return docker('exec','-T','postgres','psql','-U','interview','-d','interview','-At','-c',q).strip()
def request(path,data=None,content='application/json'):
    payload=None if data is None else (data if isinstance(data,bytes) else (json.dumps(data).encode() if content=='application/json' else urllib.parse.urlencode(data).encode()))
    req=urllib.request.Request(BASE+path,data=payload,headers={'Content-Type':content})
    with urllib.request.build_opener(LocalFormRedirect()).open(req,timeout=180) as r:
        raw=r.read().decode()
        try:result=json.loads(raw)
        except ValueError:return raw
    if isinstance(result,dict) and result.get('formWaitingUrl'):
        url=urllib.parse.urlsplit(result['formWaitingUrl'])
        if url.netloc!=urllib.parse.urlsplit(BASE).netloc:raise RuntimeError('Unexpected form waiting host')
        status_url=urllib.parse.urlunsplit(url._replace(path=url.path+'/n8n-execution-status'))
        for _ in range(120):
            with urllib.request.urlopen(status_url,timeout=5) as status:
                state=status.read().decode().strip()
            if state in ('form-waiting','success'):return result
            if state in ('error','crashed','canceled'):raise RuntimeError('Material workflow failed: '+state)
            time.sleep(0.25)
        raise RuntimeError('Material workflow did not reach its completion screen')
    return result
def chat(session,text):
    obj=request('/webhook/mock-interview-chat/chat',{'sessionId':session,'chatInput':text,'action':'sendMessage'})
    if isinstance(obj,list):obj=obj[0]
    if 'output' not in obj:raise AssertionError(obj)
    return obj['output']
def model(mode):
    code="fetch('http://mock-model:8000/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:process.argv[1]})}).then(r=>r.text()).then(console.log)"
    docker('exec','-T','n8n','node','-e',code,mode)
def check(condition,label):
    if not condition: raise AssertionError(label)
    print('PASS '+label,flush=True)

def pdf_fixture():
    """An in-memory, one-page PDF fixture with a real selectable text stream."""
    text='PDF_FIXTURE I owned a cache redesign and tested latency. I compared cache-aside with write-through.'
    stream=('BT /F1 10 Tf 40 700 Td ('+text+') Tj ET').encode()
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
    data=b'%PDF-1.4\n';offsets=[0]
    for i,o in enumerate(objects,1):
        offsets.append(len(data));data+=f'{i} 0 obj\n'.encode()+o+b'\nendobj\n'
    start=len(data)
    data+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{x:010d} 00000 n \n'.encode() for x in offsets[1:])
    return data+f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()

def docx_fixture():
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as archive:
        archive.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX_FIXTURE I personally designed Redis cache invalidation, measured response latency, and compared alternative strategies.</w:t></w:r></w:p></w:body></w:document>')
    return data.getvalue()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--provider',choices=['gemini','openai'],default='gemini')
    ap.add_argument('--embedding-provider',choices=['local','gemini','openai'],default='local')
    args=ap.parse_args()
    provider=args.provider
    embedding_provider=args.embedding_provider
    vector_table={'gemini':'interview_documents_gemini','openai':'interview_documents','local':'interview_documents_local'}[embedding_provider]
    runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
    env=runtime/'test.env'
    if not env.exists():env.write_text('POSTGRES_PASSWORD='+secrets.token_hex(24)+'\nN8N_ENCRYPTION_KEY='+secrets.token_hex(32)+'\nN8N_PORT=5679\n');env.chmod(0o600)
    if 'PORTAL_PORT=' not in env.read_text():
        with env.open('a') as handle:handle.write('PORTAL_PORT=5676\n')
    password=dict(x.split('=',1) for x in env.read_text().splitlines())['POSTGRES_PASSWORD']
    subprocess.run(['python3','scripts/build_workflows.py','--provider',provider,'--embedding-provider',embedding_provider,'--output','.runtime/test-workflows'],cwd=ROOT,check=True)
    for path in (runtime/'test-workflows').glob('interviewVoice*.json'):
        workflow=json.loads(path.read_text())
        for node in workflow['nodes']:
            if node['name']=='Gemini audio API':node['parameters']['url']=node['parameters']['url'].replace('https://generativelanguage.googleapis.com','http://mock-model:8000')
        path.write_text(json.dumps(workflow))
    docker('up','-d')
    for _ in range(120):
        try:
            request('/healthz/readiness');break
        except Exception:time.sleep(1)
    else:raise RuntimeError('Test n8n failed readiness')
    docker('exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','interview','-d','interview','-f','/docker-entrypoint-initdb.d/01-schema.sql')
    docker('restart','mock-model')
    creds=[{'id':'mockInterviewPostgres','name':'Interview Postgres','type':'postgres','data':{'host':'postgres','database':'interview','user':'interview','password':password,'port':5432,'ssl':'disable'}},
           {'id':'mockInterviewOpenAI','name':'Interview OpenAI - add API key','type':'openAiApi','data':{'apiKey':'local-test-double-only','url':'http://mock-model:8000/v1'}},
           {'id':'mockInterviewGemini','name':'Interview Gemini - add API key','type':'googlePalmApi','data':{'apiKey':'local-test-double-only','host':'http://mock-model:8000'}},
           {'id':'mockInterviewLocalEmbeddings','name':'Interview local embeddings','type':'openAiApi','data':{'apiKey':'local-only','url':'http://embeddings:8000/v1'}}]
    p=runtime/'test-credentials.json';p.write_text(json.dumps(creds));p.chmod(0o600)
    docker('exec','-T','n8n','n8n','import:credentials','--input=/import/runtime/test-credentials.json')
    docker('exec','-T','n8n','n8n','import:workflow','--separate','--input=/import/runtime/test-workflows')
    for wid in ['interviewIngest','interviewChat','interviewReview','interviewVoiceTranscribe','interviewVoiceSpeak']:docker('exec','-T','n8n','n8n','publish:workflow','--id='+wid)
    docker('restart','n8n')
    for _ in range(90):
        try:
            request('/healthz/readiness');request('/webhook/mock-interview-chat/chat');break
        except Exception:time.sleep(1)
    sql('TRUNCATE interview_messages,interview_evaluations,interview_sessions,interview_mastery,interview_topics,interview_documents,interview_documents_gemini,interview_documents_local,interview_review_plans RESTART IDENTITY CASCADE;')
    session=str(uuid.uuid4())
    check('empty' in chat(session,'/start').lower(),'empty knowledge base returns onboarding')
    def ingest(topic,title,text):
        boundary='interview-fixture-'+uuid.uuid4().hex
        fields={'field-0':topic,'field-1':title,'field-2':'resume_bullet','field-3':text}
        body=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k,v in fields.items())+f'--{boundary}--\r\n'
        result=request('/form/interview-materials',body.encode(),'multipart/form-data; boundary='+boundary)
        # n8n's native form sends an empty 200 POST response; its rendered GET
        # page owns the confirmation text. Check the actual committed source.
        check(sql("SELECT count(*) FROM interview_topics WHERE topic_id='"+topic+"';")=='1','ingest '+topic)
    ingest('test-cache','Cache design','CACHE_FIXTURE I personally designed a cache-aside layer for our API. I owned invalidation and measured latency in a repeatable load test. We considered write-through caching and rejected it because of write-path latency.')
    ingest('test-cache','Cache design revised','CACHE_FIXTURE Revised source. I personally designed the cache-aside service and invalidation policy. I measured latency using a repeatable load test and compared write-through caching before choosing cache-aside.')
    check(sql("SELECT count(DISTINCT metadata->>'revision') FROM "+vector_table+" WHERE metadata->>'topic_id'='test-cache';")=='1','reingestion replaces the prior vector revision')
    boundary='pdf-fixture-'+uuid.uuid4().hex
    fields={'field-0':'test-cache','field-1':'Cache design revised','field-2':'resume_bullet'}
    data=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k,v in fields.items()).encode()
    data+=f'--{boundary}\r\nContent-Disposition: form-data; name="field-4"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()+pdf_fixture()+f'\r\n--{boundary}--\r\n'.encode()
    request('/form/interview-materials',data,'multipart/form-data; boundary='+boundary)
    check(sql("SELECT count(*) FROM "+vector_table+" WHERE text LIKE '%PDF_FIXTURE%';")=='1','PDF upload extracts and embeds real text')
    for filename,content in [('fixture.md','\ufeff# MARKDOWN_FIXTURE\n\n## 我的项目\nI personally designed the cache policy and measured its effect.\n\n- Baseline and result\n- Alternatives considered'),('fixture.txt','TEXT_FIXTURE I personally designed the cache policy, measured its effect, and compared alternatives.')]:
        boundary='text-fixture-'+uuid.uuid4().hex
        fields={'field-0':'test-cache','field-1':'Cache design revised','field-2':'resume_bullet'}
        data=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k,v in fields.items()).encode()
        data+=f'--{boundary}\r\nContent-Disposition: form-data; name="field-4"; filename="{filename}"\r\nContent-Type: text/plain\r\n\r\n'.encode()+content.encode('utf-8')+f'\r\n--{boundary}--\r\n'.encode()
        request('/form/interview-materials',data,'multipart/form-data; boundary='+boundary)
        marker='MARKDOWN_FIXTURE' if filename.endswith('.md') else 'TEXT_FIXTURE'
        check(sql("SELECT count(*) FROM "+vector_table+" WHERE text LIKE '%"+marker+"%';")=='1',filename+' upload decodes and embeds source text')
    boundary='docx-fixture-'+uuid.uuid4().hex
    fields={'field-0':'test-cache','field-1':'Cache design revised','field-2':'resume_bullet'}
    data=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k,v in fields.items()).encode()
    data+=f'--{boundary}\r\nContent-Disposition: form-data; name="field-4"; filename="fixture.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n'.encode()+docx_fixture()+f'\r\n--{boundary}--\r\n'.encode()
    request('/form/interview-materials',data,'multipart/form-data; boundary='+boundary)
    check(sql("SELECT count(*) FROM "+vector_table+" WHERE text LIKE '%DOCX_FIXTURE%';")=='1','DOCX upload extracts and embeds source text locally')
    revision=sql("SELECT revision FROM interview_topics WHERE topic_id='test-cache';")
    ingest('test-cache','Invalid short replacement','short')
    check(sql("SELECT revision FROM interview_topics WHERE topic_id='test-cache';")==revision,'failed upload preserves the published source revision')
    ingest('test-conflict','Cross-team conflict','CONFLICT_FIXTURE I resolved a cross-team disagreement by gathering reliability evidence. I defined the escalation path and facilitated a decision with both teams. The launch went ahead with a reduced scope and a rollback plan.')
    ingest('test-design','Queue architecture','QUEUE_FIXTURE I designed an asynchronous job queue. I chose at-least-once delivery with idempotent consumers rather than exactly-once processing. I measured throughput and observed retry behavior under failure.')
    session=str(uuid.uuid4())
    q=chat(session,'/start');check(q.count('?')==1,'one opening question')
    first=sql("SELECT focus_ids[1] FROM interview_sessions WHERE chat_key='"+session+"';")
    check(int(sql("SELECT count(*) FROM interview_chat_memory WHERE session_id=(SELECT id::text FROM interview_sessions WHERE chat_key='"+session+"');"))>0,'native Postgres Chat Memory stores messages under the interview round UUID')
    for i in range(15):
        if i==2:model('bad-question')
        if i==3:model('normal')
        if i==6:model('wrong-followup-anchor')
        if i==7:model('normal')
        answer=f'I personally made decision {i}. I measured a baseline and outcome using the same load test, and accepted the complexity of invalidation.'
        if i==5:answer+=' I would finish the interview by explaining how I verified the cache policy.'
        reply=request('/webhook/mock-interview-chat/chat',{'sessionId':session,'chatInput':answer,'action':'sendMessage'})
        if isinstance(reply,list):reply=reply[0]
        q=reply['output']
        check(q.count('?')==1 and 'Progress saved' not in q,'continuous follow-up after answer '+str(i+1))
        check(reply['question_kind']==('follow_up' if i%2==0 else 'primary'),'exactly one follow-up per primary question at answer '+str(i+1))
        check(reply['primary_question_number']==(i+1)//2+1,'primary question number at answer '+str(i+1))
        if i%2==0:check('decision '+str(i) in q,'follow-up receives the exact current answer '+str(i+1))
    check(sql("SELECT status FROM interview_sessions WHERE chat_key='"+session+"';")=='active','session remains active beyond the former nine-answer cutoff')
    check(sql('SELECT sum(practice_count) FROM interview_mastery;')=='0','ongoing questions do not grade the session prematurely')
    check(sql("SELECT count(DISTINCT topic_id) FROM interview_messages WHERE session_id=(SELECT id FROM interview_sessions WHERE chat_key='"+session+"') AND role='user';")=='3','completed question pairs advance through the queued topics')
    check(sql("SELECT string_agg(phase::text,',' ORDER BY id) FROM interview_messages WHERE session_id=(SELECT id FROM interview_sessions WHERE chat_key='"+session+"') AND role='user';")==','.join(map(str,range(15))),'all fifteen answers are saved with their question positions')
    check(sql("SELECT count(*) FROM interview_messages f JOIN interview_messages p ON p.id=f.parent_question_id WHERE f.session_id=(SELECT id FROM interview_sessions WHERE chat_key='"+session+"') AND f.question_kind='follow_up' AND f.role='assistant' AND p.question_kind='primary' AND EXISTS(SELECT 1 FROM interview_messages a WHERE a.session_id=f.session_id AND a.role='user' AND a.primary_question_index=f.primary_question_index AND a.question_kind='primary' AND strpos(a.content,f.answer_quote)>0);")=='8','every follow-up stores a verified quote and parent main question')
    q=chat(session,'Finish interview.')
    check('Progress saved' in q,'spoken finish phrase explicitly triggers a saved debrief')
    check(sql("SELECT count(*) FROM interview_mastery WHERE practice_count=1;")=='3','only answered topics update when the user finishes')
    check('/start' in chat(session,'/end'),'repeated debrief cannot double-count mastery')
    check(sql('SELECT sum(practice_count) FROM interview_mastery;')=='3','mastery remains idempotent')
    session2=str(uuid.uuid4());opening=chat(session2,'/start')
    check(chat(session2,'/start')==opening,'Start on an active interview repeats the pending question')
    check('at least one' in chat(session2,'/end'),'empty interviews cannot be scored')
    chat(session2,'I personally owned the rollout but I do not have a measured outcome yet.')
    next_question=chat(session2,'/next')
    check(next_question.count('?')==1,'Next topic asks a new question without ending the interview')
    check(sql("SELECT count(*) FROM interview_messages WHERE session_id=(SELECT id FROM interview_sessions WHERE chat_key='"+session2+"') AND role='user';")=='1','Next topic is not stored or graded as an interview answer')
    chat(session2,'I chose cache-aside over write-through to keep the write path simple, accepting bounded stale reads.')
    chat(session2,'/next');chat(session2,'/next')
    check(sql("SELECT question_kind||':'||primary_question_index FROM interview_sessions WHERE chat_key='"+session2+"';")=='primary:3','manual topic changes start the next main question without an extra follow-up')
    model('wrong-topic');bad_obj=request('/webhook/mock-interview-chat/chat',{'sessionId':session2,'chatInput':'/end','action':'sendMessage'})
    if isinstance(bad_obj,list):bad_obj=bad_obj[0]
    bad=bad_obj['output']
    check('failed' in bad.lower(),'invalid assessment returns a retryable error')
    check(bad_obj.get('retryable') is True,'failed turns expose a structured retry flag to preserve the browser draft')
    check(sql('SELECT sum(practice_count) FROM interview_mastery;')=='3','invalid assessment writes no mastery changes')
    model('normal');good=chat(session2,'结束复盘。')
    check('Progress saved' in good,'Chinese debrief command retries successfully')
    check(sql('SELECT sum(practice_count) FROM interview_mastery;')=='5','user-requested debrief grades exactly the two answered topics')
    check('practiced' in chat(str(uuid.uuid4()),'/progress'),'progress survives across new chat IDs')
    session3=str(uuid.uuid4());chat(session3,'/start')
    sql("SELECT interview_begin('"+session3+"','a prepared answer','lease-fixture','"+provider+"','"+embedding_provider+"');")
    check('still being prepared' in chat(session3,'concurrent answer'),'simultaneous answers respect the session lease')
    sql("SELECT interview_release(jsonb_build_object('session_id',id,'lease_token','lease-fixture')) FROM interview_sessions WHERE chat_key='"+session3+"';")
    docker('restart','n8n')
    for _ in range(90):
        try:request('/healthz/readiness');break
        except Exception:time.sleep(1)
    check('practiced' in chat(str(uuid.uuid4()),'/progress'),'progress survives n8n restart')
    resumed=chat(session3,'I tested invalidation using the same input events before and after the change.')
    check(resumed.count('?')==1 and sql("SELECT status FROM interview_sessions WHERE chat_key='"+session3+"';")=='active','an unfinished interview continues after n8n restarts')
    stats=json.loads(docker('exec','-T','n8n','node','-e',"fetch('http://mock-model:8000/stats').then(r=>r.text()).then(console.log)"))
    check(stats['toolCalls']>0 and stats['sawSources'],'Agent calls vector tool and receives source passages')
    check(int(sql('SELECT count(*) FROM '+vector_table+';'))>0 and stats['assessments']>0,'native embeddings and structured assessment nodes execute')
    other='openai' if provider=='gemini' else 'gemini'
    check(stats['providers'][provider]>0 and stats['providers'][other]==0,'only the selected chat provider receives LLM requests')
    docker('run','--rm','n8n','execute','--id=interviewReview')
    check(sql('SELECT count(*) FROM interview_review_plans;')=='1','daily review workflow persists a review plan')
    if provider=='gemini':
        from test_voice import run_voice_checks
        run_voice_checks(check,model,sql)
        stats=json.loads(docker('exec','-T','n8n','node','-e',"fetch('http://mock-model:8000/stats').then(r=>r.text()).then(console.log)"))
    print(json.dumps({'result':'passed','provider':provider,'model':'local deterministic test double','stats':stats},indent=2),flush=True)
    docker('down')

if __name__=='__main__':main()
