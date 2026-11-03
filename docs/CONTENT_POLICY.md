# Public source policy

Only public PET resources may enter `public/data/sources.json`. Each chunk is a short original paraphrase tied to a specific URL and publisher, with a draft date, review status, jurisdiction, and source role. The current 47 summaries are drafts: their source links and metadata have been recorded, but their claims have not received a documented source-by-source expert review. Do not copy paragraphs or tables wholesale. A source title or URL does not establish publication rights for an attached file.

## Review gate

For each addition:

1. Open the exact public page and confirm that it supports the proposed summary.
2. Record publisher, publication year when visible, URL, PET and user-need tags, jurisdiction, source role, draft date, reviewer, and review date. For a public report, record document title, section, page, and the publisher's public landing page.
3. Check whether the source is draft, superseded, or jurisdiction-specific; preserve those limits in the summary.
4. Check PET terminology, including differential privacy budget direction, trusted execution versus trusted research environments, and the limits of hashing and synthetic data.
5. Run `npm run check` and inspect answers that should cite the new chunk. A valid citation ID does not prove the answer's claim is supported.

The validator permits listed MDI, NIST, ICO, U.S. Department of Education, GOV.UK, and PubMed Central hosts, plus three exact MDI report links on Box. This allowlist is a URL check, not proof that a summary is accurate or a report link is publicly accessible. The Box links require an MDI landing page. Change the allowlist in `scripts/validate-corpus.mjs` only after reviewing a new publisher.

## Exclusions and use in the model

Do not add internal meeting notes, partner contact sheets, grant budgets, unfinished PET sheets, draft slide decks, unverified public-link inventories, private repositories, raw datasets, user chats, or documents whose release rights are unclear. Supplied attachments are excluded as files even when an attachment matches a public report; use the publisher's public page or report link.

Confidential NYSED meeting notes remain local. The hosted chatbot does not retrieve them or include them in citations or “Why this answer.”

The Worker sends retrieved **public** summaries to Vertex AI as evidence. A visitor's question, recent conversation, case facts, and rule summary may also be sent when Gemini is active, so corpus approval does not make visitor input safe to share. Do not enter protected or confidential case details. Provider and host retention require separate review.

If sources conflict or one has a known error, quarantine it until reviewed. Retrieval rank is not truth or confidence. State insufficient evidence plainly and route complex choices to expert review. Source review dates are snapshots, not guarantees that external guidance remains current.
