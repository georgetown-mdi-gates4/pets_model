# Architecture

```mermaid
flowchart LR
  A[Visitor question and case details] --> B[Browser rules and public-source index]
  B --> C[Same-origin POST /api/chat]
  C --> D[Input checks and human-review gates]
  D --> E[Public-source retrieval and PET rules]
  E --> F[Vertex AI Gemini draft]
  F --> G[Citation validation]
  G --> H[Short cited answer]
  B --> I[Local source and rule fallback]
  H --> J[Local case-summary download]
  I --> J
```

## Answer path

The browser loads `public/data/sources.json`, saves chat transcripts and editable case profiles in browser storage, and can compose a deterministic fallback answer. Saved chats can be reopened on the same browser profile and are not synchronized across devices. The server imports the same 47-passage public corpus, normalizes PET vocabulary, and ranks evidence with BM25. It routes greetings, identity questions, and incomplete use cases to conversation or intake before retrieval. This prevents broad words such as “name” or a department name from triggering irrelevant pilot citations. Relevant pages in [MDI's PET resource hub](https://mdi.georgetown.edu/pets/) receive a small ranking boost; FERPA questions continue to prioritize U.S. legal guidance. This project preference is not an accuracy or authority claim. For use cases, the app keeps a technical source for each proposed PET and adds an MDI pilot example only when the question specifically asks about MDI or one of its pilots. The app combines evidence with the inspectable rules in `public/engine.mjs`. Those rules distinguish goal, input privacy, output privacy, and governance, and can propose layered PETs with counterindications.

The shared `server/http.mjs` boundary accepts a bounded JSON message, intent, case profile, and recent context. It checks request origin and size and applies a best-effort in-memory request limit. The origin check is a browser safeguard, not authentication against arbitrary HTTP clients. `server/rag.mjs` blocks selected legal-permission and risky-release cases before a model call. For PET questions with evidence, it sends Vertex AI the question, recent context, structured case facts, rule summary, and selected **public** source summaries, and requires source IDs in the answer. Ordinary chat and questions without matching sources also go to Gemini with no citations. Confidential NYSED meeting notes remain local and do not enter this path. The model call limit still applies.

The server rejects missing, invented, or malformed citations. The browser checks returned source IDs and URLs against its public corpus before display. These checks confirm citation identity and format; they cannot prove that every sentence is substantively correct. The browser uses local retrieval and rule content if the model is unavailable or returns an unusable answer.

## Hosts and deployment status

**Google Cloud Run with IAP is the selected private host.** The repository-root `Dockerfile` packages `public/`, `server/`, and `cloud-run/`. The Cloud Run adapter serves static files and `/api/chat` from one origin. IAP requires a Google sign-in. The app uses the Cloud Run metadata server to obtain an OAuth access token for a dedicated service identity, then calls the project-scoped Vertex AI Gemini endpoint. That identity has a narrow custom role with `aiplatform.endpoints.predict`; live cited answers confirm the path works. A Gemini API key is not needed for this route. One Georgetown user has accessed the private service, while the full invite policy still needs administrator confirmation. See [the setup guide](DEPLOY_GOOGLE_CLOUD_RUN.md).

The Cloud Run endpoint is intended for selected IAP-authorized users. It allows 60 valid chat requests per ten minutes across all visitors **per process**, and `cloud-run/budget.mjs` reserves at most 250 paid model calls per UTC day per process. The adapter uses one server-controlled rate key; visitor-supplied forwarding headers cannot raise the limit. Both counters reset on restart and duplicate if instances or revisions overlap. Request and model output sizes are bounded. A maximum instance setting can curb scaling but does not place a hard cap on Vertex AI charges. The browser falls back to intake questions or public-source answers if the provider is unavailable.

The existing Sites preview uses Vinext and a Cloudflare Worker. Its `/api/chat` route requires a Sites authenticated-user identity. It has no access to the GitHub Environment key, so the preview uses the browser's public-source fallback. An additional Cloudflare public-deployment implementation remains in the repository but is **not** the selected host.

## Privacy and content boundary

The corpus contains short draft summaries linked to public MDI, NIST, ICO, U.S. Department of Education, GOV.UK, and peer-reviewed sources. Their metadata and a [subset of source claims](SOURCE_AUDIT.md) have been checked, but each summary still needs a recorded expert check against its cited source. Public reports linked by MDI are represented by page-specific summaries; report files, internal notes, partner contacts, and datasets are not shipped. See [the source policy](CONTENT_POLICY.md).

Visitor text is rendered as text rather than HTML. The app does not intentionally store a server-side transcript or use analytics. Browser-local saved chats can be viewed by someone using the same browser profile; **Download** creates a local file. Gemini-enabled requests pass through the host and Google; this code alone cannot guarantee their logging or retention practices. Visitors should provide hypothetical details and avoid protected or confidential information.

The engine does not infer permission under FERPA or other laws from a PET choice. A trusted research environment and a trusted execution environment are distinct. Synthetic data are not presumed private, and a hash is not presumed anonymous. Some high-risk cases are intercepted by coded review gates; those gates are not a complete privacy or legal review.

## Evaluation and next steps

`npm run check` validates source metadata and rule citation IDs, tests decision and endpoint behavior, and checks retrieval on 15 synthetic questions. The corpus is incomplete and has not had source-by-source expert review. Tests cover coded scenarios and failure handling, not expert recommendation quality or end-to-end privacy.

Before agency-facing use, prepare authorized and de-identified case records; have PET specialists label primary and complementary methods, counterindications, and missing facts; freeze an expert test set; and measure recommendation quality, unsupported claims, abstention, privacy risk, and utility. Establish source review owners, update cadence, version history, and release approval. The current Gemini integration drafts cited PET answers from public evidence and handles ordinary chat. It does not train Gemini or replace this expert evaluation.
