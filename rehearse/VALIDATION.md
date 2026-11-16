# Validation

## Development evidence

Before packaging this submission, the local implementation passed:

- **113 Gemini-path integration checks** and **94 OpenAI compatibility checks**, using real n8n 2.47.7, PostgreSQL 17 / pgvector 0.8.1, real local embeddings, and isolated model API doubles.
- A separate live Gemini conversation with **five main-question/follow-up pairs**, exact quote validation, progression to the next main question, persistent memory, and explicit-finish scoring.
- Live Gemini transcription and speech synthesis, browser recording review/playback, and a physical laptop microphone walkthrough using synthetic speech played acoustically. That earlier hardware walkthrough preceded the current paired-question protocol; the current protocol was separately verified by the live paired conversation and integration suite.
- Actual Markdown, TXT, PDF, and DOCX ingestion, index replacement, invalid-upload preservation, and semantic retrieval.
- UI checks at **1440 × 960**, **390 × 844**, and **556 × 692**. The welcome and composer fit, without horizontal overflow. Real progress retrieval, draft persistence, and voice preference persistence passed. No browser errors were observed in the UI QA tab.

Raw live transcripts, uploaded candidate documents, recordings, and account-specific test artifacts are deliberately omitted from the public submission. The automated test source is included for reproducibility.

## Submission preparation

The submission copy is checked for JavaScript/Python syntax, workflow regeneration consistency, Docker Compose configuration, and accidental credentials/private paths before publishing. This packaging pass does not rerun the full integration suite or spend model credit.

## Scope

The tests establish workflow behavior, retrieval, state persistence, and selected error handling. Model test doubles do not establish scoring quality. Synthetic voice tests do not establish perfect transcription accuracy. The application is a local single-candidate prototype.
