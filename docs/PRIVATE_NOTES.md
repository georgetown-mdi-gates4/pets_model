# Restricted NYSED meeting notes

The attached NYSED–MDI meeting notes are confidential. NYSED approval for the PETs Model use and its five Georgetown users was confirmed by the project owner on November 3, 2026. This is retrieval context for Gemini, **not model training**. The document and prepared chunks must never be committed, copied into `public/`, embedded in the container image, or linked from an answer.

The public repository contains only the ingestion script and server code. The local prepared JSON belongs in ignored `work/` with mode `0600`. The live copy belongs in a single Secret Manager secret in `mdi-yimingwu-pets`. The project has an additional Editor outside the chatbot audience; [Google confirms](https://docs.cloud.google.com/secret-manager/docs/access-control) that Editor does not include permission to read secret payloads. Grant `pets-model-runtime@mdi-yimingwu-pets.iam.gserviceaccount.com` `roles/secretmanager.secretAccessor` on **that secret only**. Project Owners can still access secrets. Confirm the Cloud Run IAP audience contains only the five NYSED-approved Georgetown users before enabling retrieval.

Prepare the object locally:

```bash
python3 scripts/prepare-private-notes.py '/path/to/Subtasks-20261011T192301Z-1-001.zip' work/nysed-meeting-notes.private.json
```

The preparation script extracts technical observations and excludes meeting logistics; it does not put the full DOCX into the secret. Review the prepared content locally before uploading it. After the secret's access policy and IAP audience are verified, add the file as a secret version and set `PRIVATE_NOTES_SECRET_VERSION=projects/mdi-yimingwu-pets/secrets/pets-nysed-meeting-notes/versions/latest` on Cloud Run. The runtime identity fetches the secret using its metadata token. Only the three most relevant chunks, each at most 1,300 characters, can enter a grounded PET prompt. Casual chat and questions without public evidence do not retrieve private text. If the secret is unavailable, answers continue using public sources. [Google's secret version guide](https://docs.cloud.google.com/secret-manager/docs/add-secret-version).

The API returns only public source IDs and metadata. “Why this answer” links and excerpts come only from the public corpus. The prompt forbids revealing the notes, and a server-side overlap check rejects answers that reproduce a substantial phrase. These controls do **not** prove that a paraphrase cannot reveal information. Review sample answers before wider use, especially NYSED-specific questions. Revoke the secret access grant or remove `PRIVATE_NOTES_SECRET_VERSION` to disable retrieval.
