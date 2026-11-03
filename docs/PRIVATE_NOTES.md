# Restricted NYSED meeting notes

The attached NYSED–MDI meeting notes are confidential. NYSED approval for the PETs Model use and its five Georgetown users was confirmed by the project owner on November 3, 2026. This is retrieval context for Gemini, **not model training**. The document and prepared chunks must never be committed, copied into `public/`, embedded in the container image, or linked from an answer.

The public repository contains only the ingestion script and server code. The local prepared JSON belongs in ignored `work/` with mode `0600`. The live copy belongs in a dedicated private Cloud Storage bucket in `mdi-yimingwu-pets`, with uniform bucket-level access and public access prevention. Restrict bucket access to the maintainer who uploads it and `pets-model-runtime@mdi-yimingwu-pets.iam.gserviceaccount.com` for `storage.objects.get`; a bucket-level `roles/storage.objectViewer` grant is the standard read option. Confirm the Cloud Run IAP audience contains only the five NYSED-approved Georgetown users before enabling retrieval. [Google's bucket setup](https://docs.cloud.google.com/storage/docs/creating-buckets), [access roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles).

Prepare the object locally:

```bash
python3 scripts/prepare-private-notes.py '/path/to/Subtasks-20261011T192301Z-1-001.zip' work/nysed-meeting-notes.private.json
```

After the restricted bucket and IAP policy are verified, upload `work/nysed-meeting-notes.private.json` to a private object and set `PRIVATE_NOTES_GCS_URI=gs://BUCKET/nysed/meeting-notes.json` on Cloud Run. The runtime identity fetches the object using its metadata token. Only the three most relevant chunks, each at most 1,300 characters, can enter a grounded PET prompt. Casual chat and questions without public evidence do not retrieve private text. If the object is unavailable, answers continue using public sources.

The API returns only public source IDs and metadata. “Why this answer” links and excerpts come only from the public corpus. The prompt forbids revealing the notes, and a server-side overlap check rejects answers that reproduce a substantial phrase. These controls do **not** prove that a paraphrase cannot reveal information. Review sample answers before wider use, especially NYSED-specific questions. Revoke the bucket read grant or remove `PRIVATE_NOTES_GCS_URI` to disable retrieval.
