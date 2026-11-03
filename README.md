<p align="center">
  <img src="public/assets/bmo-idle.gif" alt="BMO blinking" width="96">
</p>

# PETs Model

A chatbot for exploring privacy-enhancing technologies (PETs) in education data projects. It explains options, asks for the facts needed to assess a use case, and helps plan a reviewed pilot. It is decision support, not a legal determination or an expert-approved design.

**Hosting status (November 3, 2026):** The [private Cloud Run chatbot](https://pets-model-850678646784.us-east1.run.app) is live in `mdi-yimingwu-pets`. Identity-Aware Proxy (IAP) requires a Google sign-in; `kh1399@georgetown.edu` successfully opened it. Its dedicated runtime account called Vertex AI Gemini and returned cited answers in two small live tests. The [Sites preview](https://pets-model.fluffy-buddy-4572.chatgpt.site) remains separate and uses the public-source browser fallback. Access for the other named teammates still needs administrator confirmation.

## How the chatbot works

The app uses 47 draft, original summaries linked to public sources. Some have received a [public-source spot check](docs/SOURCE_AUDIT.md); none has a recorded expert approval. For PET questions with matching public evidence, the app retrieves passages and asks Gemini for a cited answer. Other ordinary chat messages also go to Gemini and return a conversational answer without fabricated citations. Relevant [MDI PET resources](https://mdi.georgetown.edu/pets/) and pilot reports get a small priority boost in retrieval, while specialist legal and technical sources still support their respective claims. The server checks citations against the passages it supplied. Inspectable rules add PET combinations, caveats, alternatives, and missing facts for use cases. If Gemini is unavailable or fails validation, the browser shows a local rule or retrieval answer.

Legal-permission questions and selected risky releases go to human review. A PET choice does not establish authority to use or disclose data. See [the architecture](docs/ARCHITECTURE.md) for the request flow and limits.

## Share privately on Google Cloud Run

The selected host is [Google Cloud Run](https://docs.cloud.google.com/run/docs/overview). It serves the site and `/api/chat` together. [IAP directly on Cloud Run](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run) requires a Google sign-in and allows named users or a group to open the chatbot in a browser. Cloud Run uses a dedicated [service identity](https://docs.cloud.google.com/run/docs/securing/service-identity) to call the project-scoped Gemini API in Vertex AI. **No Gemini API key needs to be copied into ChatGPT, Codex, GitHub, or Cloud Run.**

The approved project has billing and the required deployment APIs enabled. The runtime account has the narrow `aiplatform.endpoints.predict` permission. IAP is enabled, but this account cannot read or edit its access policy; an administrator must confirm the five named Georgetown users. Connecting [this GitHub repository](https://github.com/kathigg/pets_model) to Cloud Build for deployment from `main` is also pending. The current state and remaining steps are in [Deploy to Google Cloud Run](docs/DEPLOY_GOOGLE_CLOUD_RUN.md).

Cloud Run has a [free allowance](https://cloud.google.com/run/pricing), but hosting can incur charges. [Vertex AI model use](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) is billed separately. The private service has zero minimum instances and a one-instance service cap. The app limits model calls to 20 per UTC day **per process**; restarts can reset that count. A cumulative **$500 project budget** is linked to a Monitoring alert channel labeled for Yiming Wu, and monthly spend caps are configured for Vertex AI ($450) and Cloud Run ($50). These controls are not a guaranteed $500 lifetime cap; other services and billing delays still need monitoring. The server logs Gemini token counts without chat content; actual charges must be checked in Cloud Billing.

## Run locally

Use Node.js 22.13 or newer:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:5173/`. The public-source fallback works without a key. Gemini answers on Cloud Run use its Google service identity, so no API key needs to be placed in this checkout or Codex.

## Privacy boundary

Use hypothetical details. When Gemini answers are active, the browser sends the current message, up to four recent conversation turns, and structured case details to the app's server endpoint. The server sends the message and recent context to Vertex AI; PET questions with matching sources also include case facts, rules, and selected **public** source summaries. This app cannot promise that the hosting platform or Google retains no request data. Do not enter protected records, direct identifiers, confidential partner information, or material you are not authorized to send to that provider.

The app does not intentionally persist chats or use analytics. The transcript and case details are held in browser memory for the session; **Download** creates a local Markdown file that the visitor can review before sharing. The public retrieval corpus contains no internal project materials or example datasets. See [the content policy](docs/CONTENT_POLICY.md).

## Repository map

| Path | Purpose |
| --- | --- |
| `public/app.mjs`, `public/styles.css`, `public/assets/` | Chat interface and mascot |
| `cloud-run/`, `Dockerfile` | Google Cloud Run host and service identity |
| `server/`, `public/engine.mjs`, `public/retrieval.mjs` | Review gates, retrieval, PET rules, and Gemini transport |
| `public/data/sources.json` | Draft public-source summaries and provenance |
| `data/eval_queries.json`, `scripts/`, `tests/` | Corpus checks and regression evaluation |
| `app/`, `vite.config.ts`, `build/sites-worker.ts` | Existing Sites preview |

The repository also retains an unused Cloudflare deployment path. Google Cloud Run with IAP is the selected private host. GitHub checks run on each push and pull request without Gemini credentials or model calls; they do not deploy the site.

## Check the project

```bash
npm run check
npm run build
```

`npm run check` validates corpus metadata and rule citations, runs decision, endpoint, and retrieval tests, and evaluates 15 synthetic retrieval questions. These checks do not establish expert accuracy, legal compliance, privacy protection, or source currency. Expert-labeled cases and privacy, utility, and security reviews are needed before agency use.

## License

Original code and original paraphrased summaries in this repository are MIT licensed. The user-supplied mascot images in `public/assets/` are excluded from that license. External pages remain with their publishers and are linked for attribution. No code or prose was copied from the unlicensed private project archive provided as background.
