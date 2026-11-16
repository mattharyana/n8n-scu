// Test double only. No real model calls or API keys. Handles OpenAI and Gemini.
import http from 'node:http';
let mode='normal';
let stats={embeddings:0,questions:0,debriefs:0,assessments:0,toolCalls:0,sawSources:false,transcriptions:0,speech:0,providers:{openai:0,gemini:0}};
function interviewQuestion(c,text){
  const title=c.topic?.title??'your project';
  const parent=c.follow_up_context;
  const quote=String(parent?.primary_answer??'').slice(0,100);
  if(mode==='bad-question')return JSON.stringify({question:'First question? Second question?',answer_quote:quote});
  if(c.question_kind==='follow_up'){
    return JSON.stringify({question:`You mentioned "${quote.replace(/[?？\n]/g,' ')}", what concrete evidence supports that point?`,answer_quote:mode==='wrong-followup-anchor'?'This was never in the answer.':quote});
  }
  const primary={ownership:`For ${title}, which decision was personally yours?`,impact:`What evidence demonstrates the impact of ${title}?`,tradeoffs:`For ${title}, which alternative did you reject and why?`,implementation:`How did you implement the key mechanism in ${title}?`,failure_modes:`What failure case most challenged ${title}?`,lessons:`What would you change if you did ${title} again?`};
  return JSON.stringify({question:primary[c.primary_objective]??primary.ownership,answer_quote:''});
}
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req) raw+=b;
  const body=raw?JSON.parse(raw):{};
  res.setHeader('content-type','application/json');
  if(req.url==='/control'){mode=body.mode??'normal';res.end(JSON.stringify({mode}));return;}
  if(req.url==='/stats'){res.end(JSON.stringify(stats));return;}
  const path=new URL(req.url,'http://fixture').pathname;
  if(path.includes('/models/')&&(path.endsWith(':embedContent')||path.endsWith(':batchEmbedContents'))){
    stats.embeddings++;stats.providers.gemini++;
    const embedding={values:Array.from({length:3072},(_,j)=>j===0?1:0)};
    res.end(JSON.stringify(path.endsWith(':batchEmbedContents')?{embeddings:(body.requests??[]).map(()=>embedding)}:{embedding}));return;
  }
  if(path.includes('/models/')&&(path.endsWith(':generateContent')||path.endsWith(':streamGenerateContent'))){
    stats.providers.gemini++;
    const contents=body.contents??[];
    const audioInput=contents.some(c=>c.parts?.some(p=>p.inlineData?.data));
    const audioOutput=body.generationConfig?.responseModalities?.includes('AUDIO');
    if(audioInput || audioOutput){
      if(mode==='billing-error' || mode==='quota-error'){
        res.statusCode=mode==='billing-error'?402:429;
        res.end(JSON.stringify({error:{code:res.statusCode,status:'RESOURCE_EXHAUSTED',message:'Fixture quota error; key=local-test-double-only'}}));return;
      }
      let parts;
      if(audioInput){
        stats.transcriptions++;
        const transcript=mode==='no-speech'?'':'I personally designed the Redis cache and tested invalidation.';
        parts=mode==='legacy-transcript'?[{text:transcript}]:[{audioTranscription:{text:transcript}}];
      }
      else {
        stats.speech++;
        if(!body.generationConfig.speechConfig?.voiceConfig?.voice){res.statusCode=400;res.end(JSON.stringify({error:{code:400,message:'Missing voice configuration'}}));return;}
        const pcm=Buffer.alloc(24000);
        for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*2000),i*2);
        // Exercise the legacy PCM-to-WAV compatibility path as well.
        let audio=pcm,mimeType='audio/L16;codec=pcm;rate=24000';
        if(mode!=='pcm-audio'){
          const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);audio=Buffer.concat([h,pcm]);mimeType='audio/wav';
        }
        if(mode==='bad-audio'){audio=Buffer.from('broken');mimeType='audio/not-real';}
        parts=[{inlineData:{mimeType,data:audio.toString('base64')}}];
      }
      res.end(JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}]}));return;
    }
    const contentText=c=>(c?.parts??[]).map(p=>p.text??JSON.stringify(p)).join('\n');
    const latest=[...contents].reverse().find(c=>c.role==='user'&&c.parts?.some(p=>p.text))??{};
    const text=contentText(body.systemInstruction??body.system_instruction)+'\n'+contents.map(contentText).join('\n');
    const tools=(body.tools??[]).flatMap(t=>t.functionDeclarations??t.function_declarations??[]);
    const lastIsTool=contents.at(-1)?.parts?.some(p=>p.functionResponse??p.function_response)??false;
    let parts;
    if(text.includes('EVALUATE_INTERVIEW_JSON')){
      stats.assessments++;
      const m=text.match(/AUTHORITATIVE TRANSCRIPT\n(\[[^\n]*\])\nDEBRIEF/);
      const answers=(m?JSON.parse(m[1]):[]).filter(m=>m.role==='user');
      const ids=[...new Set(answers.map(m=>m.topic_id))];
      parts=[{text:JSON.stringify({output:{topics:ids.map(id=>({topic_id:mode==='wrong-topic'?'hallucinated-topic':id,mastery_score:3,evidence_quote:answers.find(m=>m.topic_id===id).content.slice(0,80),weak_points:['Explain how you measured the result.'],next_action:'Rehearse one baseline-to-outcome comparison with its measurement method.'}))}})}];
    }else{
      const cm=contentText(latest).match(/CONTROL\n([^\n]*)/);
      const c=cm?JSON.parse(cm[1]):{};
      if(text.includes('FIXTURE'))stats.sawSources=true;
      if(tools.length&&!lastIsTool){
        const fn=tools[0];
        const args=Object.fromEntries(Object.keys(fn.parameters?.properties??{input:{}}).map(k=>[k,'ownership and impact']));
        stats.toolCalls++;parts=[{functionCall:{name:fn.name,args},thoughtSignature:'fixture-thought-signature'}];
      }else if(c.mode==='evaluate'){
        stats.debriefs++;parts=[{text:'You explained your own contribution. Your next practice should make the impact measurement and the rejected alternative more concrete.'}];
      }else{
        stats.questions++;parts=[{text:interviewQuestion(c,contentText(latest))}];
      }
    }
    const result={candidates:[{content:{role:'model',parts},finishReason:'STOP',index:0,safetyRatings:[]}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:20,totalTokenCount:40}};
    if(path.endsWith(':streamGenerateContent')){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify(result)+'\n\n');}
    else res.end(JSON.stringify(result));
    return;
  }
  if(req.url.endsWith('/models')){res.end(JSON.stringify({object:'list',data:[{id:'gpt-4.1-mini',object:'model'}]}));return;}
  if(req.url.endsWith('/embeddings')){
    stats.embeddings++;stats.providers.openai++;
    const input=Array.isArray(body.input)?body.input:[body.input];
    const vector=Array.from({length:1536},(_,j)=>j===0?1:0);
    const embedding=body.encoding_format==='base64'?Buffer.from(new Float32Array(vector).buffer).toString('base64'):vector;
    res.end(JSON.stringify({object:'list',data:input.map((_,i)=>({object:'embedding',index:i,embedding})),model:'text-embedding-3-small',usage:{prompt_tokens:10,total_tokens:10}}));return;
  }
  if(!req.url.endsWith('/chat/completions')){res.statusCode=404;res.end('{}');return;}
  stats.providers.openai++;
  const messages=body.messages??[];
  const text=messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  const latest=[...messages].reverse().find(m=>m.role==='user'&&typeof m.content==='string')?.content??'';
  let message={role:'assistant',content:''};
  if(text.includes('EVALUATE_INTERVIEW_JSON')){
    stats.assessments++;
    const m=text.match(/AUTHORITATIVE TRANSCRIPT\n(\[[^\n]*\])\nDEBRIEF/);
    const transcript=m?JSON.parse(m[1]):[];
    const answers=transcript.filter(m=>m.role==='user');
    const ids=[...new Set(answers.map(m=>m.topic_id))];
    message.content=JSON.stringify({output:{topics:ids.map(id=>({topic_id:mode==='wrong-topic'?'hallucinated-topic':id,mastery_score:3,evidence_quote:answers.find(m=>m.topic_id===id).content.slice(0,80),weak_points:['Explain how you measured the result.'],next_action:'Rehearse one baseline-to-outcome comparison with its measurement method.'}))}});
  }else{
    const cm=latest.match(/CONTROL\n([^\n]*)/);
    const c=cm?JSON.parse(cm[1]):{};
    if(messages.some(m=>m.role==='tool'&&String(m.content).includes('FIXTURE')))stats.sawSources=true;
    if(body.tools?.length&&messages.at(-1)?.role!=='tool'){
      const fn=body.tools[0].function;
      const properties=fn.parameters?.properties??{input:{}};
      const args=Object.fromEntries(Object.keys(properties).map(k=>[k,'ownership and impact']));
      stats.toolCalls++;
      message={role:'assistant',content:null,tool_calls:[{id:'call_fixture_'+stats.toolCalls,type:'function',function:{name:fn.name,arguments:JSON.stringify(args)}}]};
    }else if(c.mode==='evaluate'){
      stats.debriefs++;
      message.content='You explained your own contribution. Your next practice should make the impact measurement and the rejected alternative more concrete.';
    }else{
      stats.questions++;
      message.content=interviewQuestion(c,latest);
    }
  }
  const result={id:'chatcmpl_fixture',object:'chat.completion',created:Math.floor(Date.now()/1000),model:body.model??'gpt-4.1-mini',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}};
  if(body.stream){
    res.setHeader('content-type','text/event-stream');
    let delta={...message};
    if(message.tool_calls)delta.tool_calls=message.tool_calls.map((t,i)=>({index:i,...t}));
    res.write('data: '+JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  }else res.end(JSON.stringify(result));
});
server.listen(8000,'0.0.0.0');
