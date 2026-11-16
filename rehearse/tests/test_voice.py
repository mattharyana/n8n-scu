"""Exercise the real portal and n8n audio workflows against the model double."""
import base64
import io
import json
import urllib.error
import urllib.request
import wave

def run_voice_checks(check,model,sql):
    def call(path,payload=None,origin=None):
        headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=origin
        req=urllib.request.Request('http://localhost:5676'+path,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
        try:r=urllib.request.urlopen(req,timeout=110)
        except urllib.error.HTTPError as error:r=error
        with r:
            data=r.read()
            try:data=json.loads(data)
            except ValueError:data=data.decode()
            return r.status,data
    status,body=call('/')
    check(status==200 and 'Record answer' in body,'voice portal serves the recording interface')
    status,body=call('/api/status')
    check(status==200 and body['connected'],'voice portal reaches local n8n')
    status,body=call('/api/chat',{'sessionId':'voice-progress-check','chatInput':'/progress'})
    check(status==200 and 'practiced' in body['output'],'portal chat proxy reads persistent progress')
    status,body=call('/api/chat',{'sessionId':'voice-progress-check','chatInput':'/progress'},'https://untrusted.example')
    check(status==403,'portal rejects cross-site requests')
    status,body=call('/api/transcribe',{'audioBase64':'bad','mimeType':'text/plain'})
    check(status==400 and 'audio' in body['error'],'invalid audio is rejected before calling Gemini')
    status,body=call('/api/speak',{'text':'','voice':'Kore'})
    check(status==400,'empty speech requests are rejected')
    status,body=call('/api/speak',{'text':'Hello','voice':'invented'})
    check(status==400,'unsupported voices are rejected')
    fixture=io.BytesIO()
    with wave.open(fixture,'wb') as wav:wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(b'\0\0'*12000)
    audio={'audioBase64':base64.b64encode(fixture.getvalue()).decode(),'mimeType':'audio/wav'}
    before=sql('SELECT count(*) FROM interview_messages;')
    model('normal')
    status,body=call('/api/transcribe',audio)
    check(status==200 and 'Redis cache' in body['text'],'native Gemini audio workflow returns a transcript')
    model('legacy-transcript');status,body=call('/api/transcribe',audio)
    check(status==200 and 'Redis cache' in body['text'],'plain-text transcription responses remain supported')
    model('normal')
    check(sql('SELECT count(*) FROM interview_messages;')==before,'transcription does not submit an unreviewed interview answer')
    status,body=call('/api/speak',{'text':'Which decision was personally yours?','voice':'Kore'})
    check(status==200 and body['mimeType']=='audio/wav','native Gemini speech workflow returns playable WAV audio')
    decoded=base64.b64decode(body['audioBase64'])
    with wave.open(io.BytesIO(decoded),'rb') as wav:valid=wav.getnframes()>0 and wav.getframerate()==24000
    check(valid,'returned WAV contains decodable audio samples')
    model('pcm-audio');status,body=call('/api/speak',{'text':'Hello','voice':'Puck'})
    check(status==200 and base64.b64decode(body['audioBase64'])[:4]==b'RIFF','legacy PCM speech is wrapped as browser-playable WAV')
    model('bad-audio');status,body=call('/api/speak',{'text':'Hello'})
    check(status==502 and 'audio' in body['error'],'invalid model audio never appears as a successful response')
    model('no-speech');status,body=call('/api/transcribe',audio)
    check(status==422 and 'No speech' in body['error'],'empty transcription returns a useful retry message')
    model('billing-error');status,body=call('/api/transcribe',audio)
    check(status==402 and 'prepayment' in body['error'],'Gemini billing rejection reaches the portal clearly')
    check('local-test-double-only' not in json.dumps(body),'provider errors cannot expose credential strings')
    model('quota-error');status,body=call('/api/speak',{'text':'Hello'})
    check(status==429 and 'quota' in body['error'],'Gemini rate limits reach the portal clearly')
    check(sql('SELECT count(*) FROM interview_messages;')==before,'failed voice requests preserve interview history')
    model('normal')
