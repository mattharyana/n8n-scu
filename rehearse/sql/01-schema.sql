CREATE SCHEMA IF NOT EXISTS n8n;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS interview_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(1536)
);
CREATE INDEX IF NOT EXISTS interview_document_topic ON interview_documents ((metadata->>'topic_id'));
CREATE TABLE IF NOT EXISTS interview_documents_gemini (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(3072)
);
CREATE INDEX IF NOT EXISTS interview_gemini_document_topic ON interview_documents_gemini ((metadata->>'topic_id'));
CREATE TABLE IF NOT EXISTS interview_documents_local (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(384)
);
CREATE INDEX IF NOT EXISTS interview_local_document_topic ON interview_documents_local ((metadata->>'topic_id'));

CREATE TABLE IF NOT EXISTS interview_topics (
  topic_id text PRIMARY KEY CHECK (topic_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('resume_bullet','bq_story','system_design')),
  revision text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview_topics ADD COLUMN IF NOT EXISTS embedding_provider text NOT NULL DEFAULT 'openai'
  CHECK (embedding_provider IN ('openai','gemini','local'));
ALTER TABLE interview_topics DROP CONSTRAINT IF EXISTS interview_topics_embedding_provider_check;
ALTER TABLE interview_topics ADD CONSTRAINT interview_topics_embedding_provider_check CHECK (embedding_provider IN ('openai','gemini','local'));
CREATE TABLE IF NOT EXISTS interview_mastery (
  topic_id text PRIMARY KEY REFERENCES interview_topics(topic_id),
  practice_count integer NOT NULL DEFAULT 0,
  mastery_score integer CHECK (mastery_score BETWEEN 1 AND 5),
  weakness_notes jsonb NOT NULL DEFAULT '[]',
  next_action text,
  last_practiced_at timestamptz,
  next_review_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_key text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  focus_ids text[] NOT NULL,
  topic_index integer NOT NULL DEFAULT 1,
  question_index integer NOT NULL DEFAULT -1,
  lease_token text,
  lease_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS model_provider text NOT NULL DEFAULT 'openai'
  CHECK (model_provider IN ('openai','gemini'));
ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS question_kind text NOT NULL DEFAULT 'primary'
  CHECK (question_kind IN ('primary','follow_up'));
ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS primary_question_index integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS one_active_interview;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_interview_provider ON interview_sessions(chat_key,model_provider) WHERE status='active';
CREATE TABLE IF NOT EXISTS interview_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES interview_sessions(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  topic_id text REFERENCES interview_topics(topic_id),
  phase integer,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interview_message_session ON interview_messages(session_id,id);
ALTER TABLE interview_messages ADD COLUMN IF NOT EXISTS question_kind text;
ALTER TABLE interview_messages ADD COLUMN IF NOT EXISTS primary_question_index integer;
ALTER TABLE interview_messages ADD COLUMN IF NOT EXISTS answer_quote text;
ALTER TABLE interview_messages ADD COLUMN IF NOT EXISTS parent_question_id bigint;
CREATE TABLE IF NOT EXISTS interview_evaluations (
  session_id uuid PRIMARY KEY REFERENCES interview_sessions(id),
  summary text NOT NULL,
  assessment jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview_review_plans (
  plan_date date PRIMARY KEY,
  topics jsonb NOT NULL,
  digest text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW interview_progress AS
SELECT t.topic_id,t.title,t.category,m.practice_count,m.mastery_score,m.weakness_notes,
       m.next_action,m.last_practiced_at,m.next_review_at,
       CASE WHEN m.practice_count=0 THEN 'unpracticed'
            WHEN m.mastery_score<=3 AND m.next_review_at<=now() THEN 'high'
            WHEN m.next_review_at<=now() THEN 'due' ELSE 'scheduled' END AS priority
FROM interview_topics t JOIN interview_mastery m USING(topic_id);

-- New vectors are written before this transaction; unsuccessful indexing leaves
-- the previous revision usable. Only published topic revisions can be retrieved.
CREATE OR REPLACE FUNCTION interview_publish_topic(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE provider text:=coalesce(p->>'embedding_provider','openai'); table_name text; indexed boolean; chunks integer;
BEGIN
  table_name:=CASE provider WHEN 'openai' THEN 'interview_documents' WHEN 'gemini' THEN 'interview_documents_gemini' WHEN 'local' THEN 'interview_documents_local' END;
  IF table_name IS NULL THEN RAISE EXCEPTION 'Unknown embedding provider'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ingest:'||(p->>'topic_id')));
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE metadata->>''revision''=$1 AND metadata->>''topic_id''=$2)',table_name)
    INTO indexed USING p->>'revision',p->>'topic_id';
  IF NOT indexed THEN RAISE EXCEPTION 'No indexed document'; END IF;
  INSERT INTO interview_topics(topic_id,title,category,revision,embedding_provider)
  VALUES(p->>'topic_id',p->>'title',p->>'category',p->>'revision',provider)
  ON CONFLICT(topic_id) DO UPDATE SET title=EXCLUDED.title,category=EXCLUDED.category,
    revision=EXCLUDED.revision,embedding_provider=EXCLUDED.embedding_provider,updated_at=now();
  INSERT INTO interview_mastery(topic_id) VALUES(p->>'topic_id')
  ON CONFLICT(topic_id) DO UPDATE SET next_review_at=now();
  EXECUTE format('DELETE FROM %I WHERE metadata->>''topic_id''=$1 AND metadata->>''revision'' IS DISTINCT FROM $2',table_name)
    USING p->>'topic_id',p->>'revision';
  EXECUTE format('SELECT count(*) FROM %I WHERE metadata->>''topic_id''=$1 AND metadata->>''revision''=$2',table_name)
    INTO chunks USING p->>'topic_id',p->>'revision';
  RETURN jsonb_build_object('output','Indexed: '||(p->>'title')||' ('||chunks||' searchable passage'||CASE WHEN chunks=1 THEN '' ELSE 's' END||'). You can now start a practice session.','topic_id',p->>'topic_id','chunks',chunks);
END $$;

DROP FUNCTION IF EXISTS interview_begin(text,text,text);
DROP FUNCTION IF EXISTS interview_begin(text,text,text,text);
CREATE OR REPLACE FUNCTION interview_begin(p_key text,p_input text,p_token text,p_provider text DEFAULT 'openai',p_embedding_provider text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s interview_sessions%ROWTYPE; ids text[]; history jsonb; topic jsonb;
  ni integer; nq integer; pi integer; kind text; objective text; parent jsonb:='null'; mode text:='interview'; pending jsonb:='null'; cmd text;
BEGIN
  cmd:=lower(regexp_replace(replace(trim(p_input),'’',chr(39)),'[[:space:].!?。！？]+$','','g'));
  IF cmd IN ('end interview','finish interview','end session','finish session','finish the interview','please finish the interview','let''s finish','let''s wrap up','结束复盘','结束面试') THEN cmd:='/end'; END IF;
  IF cmd IN ('next topic','switch topic','下个话题','换个话题') THEN cmd:='/next'; END IF;
  IF p_provider NOT IN ('openai','gemini') THEN RAISE EXCEPTION 'Unknown model provider'; END IF;
  p_embedding_provider:=coalesce(p_embedding_provider,p_provider);
  IF p_embedding_provider NOT IN ('openai','gemini','local') THEN RAISE EXCEPTION 'Unknown embedding provider'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('chat:'||p_key));
  IF cmd IN ('/help','help') THEN RETURN jsonb_build_object('action','reply','output',
    'Upload a topic first, then send /start. Each main question has one answer-based follow-up, then the next main question. Continue until you finish. /end, Finish interview, or 结束复盘 saves a scored debrief. /next changes the topic. /progress shows coverage and /review shows due topics.'); END IF;
  IF cmd IN ('/progress','/review') THEN
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY CASE p.priority WHEN 'unpracticed' THEN 0 WHEN 'high' THEN 1 WHEN 'due' THEN 2 ELSE 3 END,p.next_review_at),'[]') INTO history
    FROM interview_progress p JOIN interview_topics t USING(topic_id)
    WHERE cmd='/progress' OR (p.priority<>'scheduled' AND t.embedding_provider=p_embedding_provider);
    RETURN jsonb_build_object('action','progress','command',cmd,'topics',history);
  END IF;
  SELECT * INTO s FROM interview_sessions WHERE chat_key=p_key AND model_provider=p_provider AND status='active' FOR UPDATE;
  IF NOT FOUND THEN
    IF cmd IN ('/end','/next') THEN RETURN jsonb_build_object('action','reply','output','No active interview. Send /start to begin.'); END IF;
    SELECT array_agg(topic_id) INTO ids FROM (SELECT p.topic_id FROM interview_progress p
      JOIN interview_topics t USING(topic_id) WHERE t.embedding_provider=p_embedding_provider
      ORDER BY CASE priority WHEN 'unpracticed' THEN 0 WHEN 'high' THEN 1 WHEN 'due' THEN 2 ELSE 3 END,
        next_review_at,coalesce(mastery_score,0),topic_id LIMIT 3) q;
    IF coalesce(cardinality(ids),0)=0 THEN RETURN jsonb_build_object('action','reply','output',
      'Your knowledge base is empty for '||p_provider||'. Open http://localhost:5678/form/interview-materials and add or re-upload a resume experience or behavioral story first.'); END IF;
    INSERT INTO interview_sessions(chat_key,focus_ids,model_provider) VALUES(p_key,ids,p_provider) RETURNING * INTO s;
  ELSIF s.lease_until>now() THEN
    RETURN jsonb_build_object('action','reply','retryable',true,'output','A response is still being prepared. Wait for it to finish before sending another answer.');
  ELSIF cmd IN ('/start','start') AND s.question_index>=0 THEN
    RETURN jsonb_build_object('action','reply','question_kind',s.question_kind,'primary_question_number',s.primary_question_index+1,'output',coalesce((SELECT content FROM interview_messages
      WHERE session_id=s.id AND role='assistant' ORDER BY id DESC LIMIT 1),'Send your answer to continue.'));
  END IF;
  IF left(cmd,1)='/' AND cmd NOT IN ('/start','/end','/next') THEN
    RETURN jsonb_build_object('action','reply','output','Unknown command. Use /start, /end, /next, /progress, /review, or /help.');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('role',role,'topic_id',topic_id,'phase',phase,'question_kind',question_kind,'primary_question_index',primary_question_index,'content',content) ORDER BY id),'[]')
    INTO history FROM interview_messages WHERE session_id=s.id;
  ni:=s.topic_index; nq:=s.question_index; pi:=s.primary_question_index; kind:=s.question_kind;
  IF cmd='/end' THEN
    IF NOT EXISTS(SELECT 1 FROM interview_messages WHERE session_id=s.id AND role='user') THEN
      RETURN jsonb_build_object('action','reply','output','Answer at least one interview question before requesting a scored debrief.'); END IF;
    mode:='evaluate';
  ELSIF cmd='/next' THEN
    IF cardinality(s.focus_ids)<2 THEN
      RETURN jsonb_build_object('action','reply','output','This interview has one topic. Answer the current question or choose Finish to save your debrief.'); END IF;
    ni:=s.topic_index%cardinality(s.focus_ids)+1;
    nq:=nq+1; pi:=pi+1; kind:='primary';
  ELSIF s.question_index>=0 THEN
    pending:=jsonb_build_object('role','user','topic_id',s.focus_ids[s.topic_index],'phase',s.question_index,
      'question_kind',s.question_kind,'primary_question_index',s.primary_question_index,'content',p_input);
    history:=history||jsonb_build_array(pending);
    nq:=nq+1;
    IF s.question_kind='primary' THEN
      kind:='follow_up';
      SELECT jsonb_build_object('primary_question_id',id,'primary_question',content,'primary_answer',p_input)
        INTO parent FROM interview_messages WHERE session_id=s.id AND role='assistant' AND phase=s.question_index ORDER BY id DESC LIMIT 1;
      IF parent IS NULL THEN RAISE EXCEPTION 'Primary question not found'; END IF;
    ELSE
      kind:='primary'; pi:=pi+1;
      ni:=s.topic_index%cardinality(s.focus_ids)+1;
    END IF;
  ELSE nq:=0; kind:='primary';
  END IF;
  objective:=(ARRAY['ownership','impact','tradeoffs','implementation','failure_modes','lessons'])[(pi/greatest(cardinality(s.focus_ids),1))%6+1];
  SELECT to_jsonb(p)||jsonb_build_object('revision',t.revision) INTO topic
    FROM interview_progress p JOIN interview_topics t USING(topic_id) WHERE p.topic_id=s.focus_ids[ni];
  UPDATE interview_sessions SET lease_token=p_token,lease_until=now()+interval '5 minutes' WHERE id=s.id;
  RETURN jsonb_build_object('action',mode,'session_id',s.id,'lease_token',p_token,
    'topic',topic,'next_topic_index',ni,'next_question_index',nq,
    'next_question_kind',kind,'primary_question_index',pi,'primary_objective',objective,'follow_up_context',parent,
    'transcript',history,'pending_answer',pending,'chatInput',p_input);
END $$;

CREATE OR REPLACE FUNCTION interview_commit_question(p jsonb,p_output text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s interview_sessions%ROWTYPE; a jsonb:=p->'pending_answer';
BEGIN
  SELECT * INTO s FROM interview_sessions WHERE id=(p->>'session_id')::uuid FOR UPDATE;
  IF s.status<>'active' OR s.lease_token IS DISTINCT FROM p->>'lease_token' THEN RAISE EXCEPTION 'Stale interview turn'; END IF;
  IF p->>'next_question_kind'='follow_up' THEN
    IF a='null'::jsonb OR a->>'question_kind'<>'primary' OR coalesce(p->>'answer_quote','')='' OR strpos(a->>'content',p->>'answer_quote')=0 THEN
      RAISE EXCEPTION 'Follow-up must quote its primary answer'; END IF;
    IF NOT EXISTS (SELECT 1 FROM interview_messages WHERE id=(p->'follow_up_context'->>'primary_question_id')::bigint AND session_id=s.id AND role='assistant') THEN
      RAISE EXCEPTION 'Follow-up parent must belong to this session'; END IF;
  END IF;
  IF a<>'null'::jsonb THEN INSERT INTO interview_messages(session_id,role,topic_id,phase,question_kind,primary_question_index,content)
    VALUES(s.id,'user',a->>'topic_id',(a->>'phase')::int,a->>'question_kind',(a->>'primary_question_index')::int,a->>'content'); END IF;
  INSERT INTO interview_messages(session_id,role,topic_id,phase,question_kind,primary_question_index,answer_quote,parent_question_id,content)
    VALUES(s.id,'assistant',p->'topic'->>'topic_id',(p->>'next_question_index')::int,p->>'next_question_kind',(p->>'primary_question_index')::int,
      nullif(p->>'answer_quote',''),(p->'follow_up_context'->>'primary_question_id')::bigint,p_output);
  UPDATE interview_sessions SET topic_index=(p->>'next_topic_index')::int,
    question_index=(p->>'next_question_index')::int,question_kind=p->>'next_question_kind',primary_question_index=(p->>'primary_question_index')::int,
    lease_token=null,lease_until=null WHERE id=s.id;
  RETURN jsonb_build_object('output',p_output,'question_kind',p->>'next_question_kind','primary_question_number',(p->>'primary_question_index')::int+1,'answer_quote',coalesce(p->>'answer_quote',''));
END $$;

CREATE OR REPLACE FUNCTION interview_commit_evaluation(p jsonb,report jsonb,p_summary text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s interview_sessions%ROWTYPE; a jsonb:=p->'pending_answer'; item jsonb;
BEGIN
  SELECT * INTO s FROM interview_sessions WHERE id=(p->>'session_id')::uuid FOR UPDATE;
  IF EXISTS(SELECT 1 FROM interview_evaluations WHERE session_id=s.id) THEN
    RETURN jsonb_build_object('output','This round was already evaluated. Send /start for another round.'); END IF;
  IF s.status<>'active' OR s.lease_token IS DISTINCT FROM p->>'lease_token' THEN RAISE EXCEPTION 'Stale evaluation'; END IF;
  IF a<>'null'::jsonb THEN INSERT INTO interview_messages(session_id,role,topic_id,phase,content)
    VALUES(s.id,'user',a->>'topic_id',(a->>'phase')::int,a->>'content'); END IF;
  IF jsonb_array_length(report->'topics')<>(SELECT count(DISTINCT topic_id) FROM interview_messages WHERE session_id=s.id AND role='user') THEN
    RAISE EXCEPTION 'Assessment must include exactly the answered topics'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(report->'topics') LOOP
    IF NOT EXISTS(SELECT 1 FROM interview_messages WHERE session_id=s.id AND role='user' AND topic_id=item->>'topic_id') THEN
      RAISE EXCEPTION 'Cannot grade an unanswered topic'; END IF;
    UPDATE interview_mastery SET practice_count=practice_count+1,
      mastery_score=(item->>'mastery_score')::int,weakness_notes=item->'weak_points',next_action=item->>'next_action',
      last_practiced_at=now(),next_review_at=now()+CASE (item->>'mastery_score')::int
        WHEN 1 THEN interval '1 day' WHEN 2 THEN interval '1 day' WHEN 3 THEN interval '2 days'
        WHEN 4 THEN interval '7 days' ELSE interval '14 days' END WHERE topic_id=item->>'topic_id';
  END LOOP;
  INSERT INTO interview_evaluations(session_id,summary,assessment) VALUES(s.id,p_summary,report);
  INSERT INTO interview_messages(session_id,role,content) VALUES(s.id,'assistant',p_summary);
  UPDATE interview_sessions SET status='completed',completed_at=now(),lease_token=null,lease_until=null WHERE id=s.id;
  RETURN jsonb_build_object('output',p_summary,'report',report);
END $$;

CREATE OR REPLACE FUNCTION interview_release(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interview_sessions SET lease_token=null,lease_until=null
    WHERE id=(p->>'session_id')::uuid AND lease_token=p->>'lease_token';
  RETURN jsonb_build_object('retryable',true,'output','The model or scoring step failed. Your saved progress has not changed. Please resend your last answer or /end. Check the workflow execution for details.');
END $$;
