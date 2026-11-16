"""Native n8n webhooks and credential-backed Gemini audio requests."""

ERROR_JS = r'''
const j=$json;
const status=Number(j.statusCode ?? j.error?.statusCode ?? 0);
const upstream=j.body?.error;
if (status>=400 || j.error || upstream) {
 let message='Gemini could not complete this audio request. Please retry.';
 let code=status>=400 && status<=599?status:502;
 if(status===402) message='Gemini prepayment credits are depleted. Add prepaid credit in Google AI Studio billing, then retry. n8n Assistant credits do not cover Gemini API calls.';
 else if(status===401 || status===403) message='Gemini rejected the saved API key or project permissions. Check the Interview Gemini credential in n8n.';
 else if(status===429) message='Gemini rate limit or quota reached. Wait a moment or check your Google project quota.';
 else if(status===404) message='The configured Gemini audio model is unavailable. Check voice_models in model-config.json.';
 else if(status===400) message='Gemini rejected this audio format or model configuration. Try a WAV recording or check the configured audio model.';
 else if(!status) message='Gemini could not be reached or timed out. Please retry.';
 return [{json:{statusCode:code,error:message}}];
}
const body=j.body ?? j;
const parts=(body.candidates?.[0]?.content?.parts ?? []).filter(p=>!p.thought);
'''

TRANSCRIBE_JS = r'''
const origin=$json.headers?.origin;
if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return [{json:{statusCode:403,error:'Cross-site requests are not allowed.'}}];
const j=$json.body ?? $json;
const mimeType=String(j.mimeType??'').toLowerCase().split(';')[0].trim();
const allowed=['audio/wav','audio/x-wav','audio/webm','audio/mp4','audio/mpeg','audio/mp3','audio/m4a','audio/ogg','audio/flac','audio/aac'];
const data=j.audioBase64;
let error;
if(!allowed.includes(mimeType)) error='Upload a WAV, WebM, MP4/M4A, MP3, OGG, FLAC, or AAC audio recording.';
else if(typeof data!=='string' || !data || data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) error='Record or upload a valid audio file first.';
else if(data.length>13333336 || Buffer.from(data,'base64').length>10000000) error='Audio must be smaller than 10 MB. Record a shorter answer.';
else if(Buffer.from(data,'base64').length<44) error='This recording is empty or too short. Record your answer again.';
if(error) return [{json:{statusCode:400,error}}];
return [{json:{audioBase64:data,mimeType:mimeType==='audio/x-wav'?'audio/wav':mimeType}}];
'''

SPEAK_JS = r'''
const origin=$json.headers?.origin;
if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return [{json:{statusCode:403,error:'Cross-site requests are not allowed.'}}];
const j=$json.body ?? $json;
const text=typeof j.text==='string'?j.text.trim():'';
const voice=j.voice ?? 'Kore';
if(!text || text.length>10000) return [{json:{statusCode:400,error:'Choose a reply of 1–10,000 characters to read aloud.'}}];
if(!['Kore','Puck','Aoede','Charon','Fenrir'].includes(voice)) return [{json:{statusCode:400,error:'Choose a supported interviewer voice.'}}];
return [{json:{text,voice}}];
'''

AUDIO_RESULT_JS = r'''
const part=parts.find(p=>p.inlineData?.data || p.inline_data?.data);
const inline=part?.inlineData ?? part?.inline_data;
if(!inline) return [{json:{statusCode:502,error:'Gemini returned no spoken audio. Please retry.'}}];
let audio=Buffer.from(inline.data,'base64');
const mime=String(inline.mimeType ?? inline.mime_type ?? '').toLowerCase();
if(!audio.length || audio.length>20000000) return [{json:{statusCode:502,error:'Gemini returned invalid audio. Please retry.'}}];
let mimeType='audio/wav';
if(audio.toString('ascii',0,4)==='RIFF' && audio.toString('ascii',8,12)==='WAVE') {
 if(audio.length<44) return [{json:{statusCode:502,error:'Gemini returned an incomplete WAV file. Please retry.'}}];
} else if(mime.startsWith('audio/l16') || mime.startsWith('audio/pcm')) {
 const rate=Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000);
 if(audio.length%2 || rate<8000 || rate>48000) return [{json:{statusCode:502,error:'Gemini returned invalid PCM audio. Please retry.'}}];
 const header=Buffer.alloc(44);
 header.write('RIFF',0);header.writeUInt32LE(36+audio.length,4);header.write('WAVE',8);
 header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
 header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
 header.write('data',36);header.writeUInt32LE(audio.length,40);audio=Buffer.concat([header,audio]);
} else if(mime==='audio/mpeg' || mime==='audio/mp3') mimeType='audio/mpeg';
else return [{json:{statusCode:502,error:'Gemini returned an unsupported audio format. Please retry.'}}];
return [{json:{statusCode:200,audioBase64:audio.toString('base64'),mimeType}}];
'''

def voice_flows(Flow, BASE, GEMINI, config):
    models=config.get('voice_models',{})
    for kind, title, validate, model in [
        ('transcribe','Transcribe voice answer',TRANSCRIBE_JS,models.get('transcription','gemini-3.5-transcribe')),
        ('speak','Speak interviewer reply',SPEAK_JS,models.get('speech','gemini-3.8-flash-lite-tts')),
    ]:
        wid='interviewVoiceTranscribe' if kind=='transcribe' else 'interviewVoiceSpeak'
        f=Flow(wid,'Interview 04 - '+title if kind=='transcribe' else 'Interview 05 - '+title)
        f.node('Voice request',BASE+'webhook',{'httpMethod':'POST','path':'interview-voice-'+kind,'responseMode':'responseNode','options':{}},0,version=2.1,webhookId='interview-voice-'+kind)
        f.code('Validate audio request',validate,240)
        f.condition('Valid audio request','={{ !$json.error }}',480)
        if kind=='transcribe':
            # Dedicated transcription model receives only the audio. Its output
            # is reviewed by the candidate before it can enter scored history.
            body='={{ JSON.stringify({contents:[{role:"user",parts:[{inlineData:{mimeType:$json.mimeType,data:$json.audioBase64}}]}],generationConfig:{maxOutputTokens:8192}}) }}'
            result=ERROR_JS+r'''
const text=parts.map(p=>p.audioTranscription?.text ?? p.audio_transcription?.text ?? p.text ?? '').join('').trim();
if(!text) return [{json:{statusCode:422,error:'No speech was recognized. Try recording again in a quieter place.'}}];
if(text.length>12000) return [{json:{statusCode:422,error:'This transcript is too long. Split your answer into shorter recordings.'}}];
return [{json:{statusCode:200,text}}];
'''
        else:
            if model.startswith('gemini-3.8-'):
                body='={{ JSON.stringify({contents:[{role:"user",parts:[{text:$json.text,speech_metadata:{style:"Calm, clear professional interviewer. Natural conversational pace."}}]}],generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{voice:$json.voice}}}}) }}'
            else:
                body='={{ JSON.stringify({contents:[{role:"user",parts:[{text:$json.text}]}],generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:$json.voice}}}}}) }}'
            result=ERROR_JS+AUDIO_RESULT_JS
        # Build nested objects in a Code node. Keeping only a simple field
        # reference in the HTTP expression avoids n8n's template lexer
        # interpreting adjacent closing object braces as an expression ending.
        request_expression=body[3:-2].strip()
        request_object=request_expression[len('JSON.stringify('):-1]
        f.code('Build Gemini request','return [{json:{requestBody:'+request_object+'}}];',600)
        f.node('Gemini audio API',BASE+'httpRequest',{
            'method':'POST','url':'https://generativelanguage.googleapis.com/v1beta/models/'+model.removeprefix('models/')+':generateContent',
            'authentication':'predefinedCredentialType','nodeCredentialType':'googlePalmApi','sendBody':True,'specifyBody':'json','jsonBody':'={{ JSON.stringify($json.requestBody) }}',
            'options':{'timeout':90000,'response':{'response':{'fullResponse':True,'neverError':True,'responseFormat':'json'}}},
        },720,version=4.2,credentials=GEMINI,onError='continueErrorOutput')
        f.code('Format audio result',result,960)
        f.node('Return audio result',BASE+'respondToWebhook',{'respondWith':'json','responseBody':'={{ $json }}','options':{'responseCode':'={{ $json.statusCode ?? 200 }}','responseHeaders':{'entries':[{'name':'Cache-Control','value':'no-store'}]}}},1200,version=1.5)
        f.link('Voice request','Validate audio request');f.link('Validate audio request','Valid audio request')
        f.link('Valid audio request','Build Gemini request');f.link('Build Gemini request','Gemini audio API');f.link('Valid audio request','Return audio result',branch=1)
        f.link('Gemini audio API','Format audio result');f.link('Gemini audio API','Format audio result',branch=1)
        f.link('Format audio result','Return audio result')
        f.note('## Gemini voice\nCalled by the local interview portal. Uses your saved Interview Gemini credential.\nTranscripts are reviewed before submission. Audio requests are not saved in n8n execution payloads.\nModel: **'+model+'**',0,-300,660,220)
        # Voice payloads are transient; only submitted text belongs in the
        # authoritative interview transcript, never raw microphone recordings.
        f.settings={'saveDataSuccessExecution':'none','saveDataErrorExecution':'none','saveManualExecutions':False}
        f.save()
