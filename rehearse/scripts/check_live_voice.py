#!/usr/bin/env python3
"""Send short, explicit live Gemini audio checks through the local n8n portal.

Uses n8n's saved credential; never reads, exports, or prints an API key.
The fixture must be a synthetic recording, not a private microphone recording.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import urllib.error
import urllib.request
import wave

ROOT=Path(__file__).resolve().parents[1]

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('fixture',type=Path,help='A short synthetic WAV speech fixture.')
    ap.add_argument('--portal',default='http://localhost:5677')
    args=ap.parse_args()
    def call(path,body=None):
        req=urllib.request.Request(args.portal+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        try:r=urllib.request.urlopen(req,timeout=110)
        except urllib.error.HTTPError as error:r=error
        with r:return r.status,json.load(r)
    fixture=args.fixture.read_bytes()
    with wave.open(io.BytesIO(fixture),'rb') as wav:
        seconds=wav.getnframes()/wav.getframerate()
        if not 0<seconds<=15:raise SystemExit('Use a synthetic WAV fixture lasting 1–15 seconds.')
    status,info=call('/api/status')
    results={'portal':{'httpStatus':status,'n8nConnected':info.get('connected'),'voiceModels':info.get('voiceModels')}}
    for label,path,body in [
        ('transcription','/api/transcribe',{'audioBase64':base64.b64encode(fixture).decode(),'mimeType':'audio/wav'}),
        ('speech','/api/speak',{'text':'Which decision was personally yours?','voice':'Kore'}),
    ]:
        status,result=call(path,body)
        if label=='speech' and status==200 and result.get('audioBase64'):
            audio=base64.b64decode(result['audioBase64'])
            with wave.open(io.BytesIO(audio),'rb') as wav:duration=wav.getnframes()/wav.getframerate()
            (ROOT/'tests/gemini-live-reply.wav').write_bytes(audio)
            results[label]={'httpStatus':status,'mimeType':result['mimeType'],'seconds':round(duration,2),'bytes':len(audio)}
        else:results[label]={'httpStatus':status,**{k:v for k,v in result.items() if k in ('text','error')}}
    (ROOT/'.runtime/live-voice-result.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(results,indent=2))

if __name__=='__main__':main()
