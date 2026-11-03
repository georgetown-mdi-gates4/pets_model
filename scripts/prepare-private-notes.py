"""Prepare private DOCX meeting notes for a restricted GCS object.

The output must stay outside Git and the public web directory. This script
does not upload or disclose the source file.
"""

import argparse
import json
import os
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from io import BytesIO


DOCX_NAME = "NYSED-MDI Running Meeting Notes.docx"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
TECHNICAL = re.compile(
    r"privacy|enclave|clean room|synthetic|metadata|governance|record link|linkage|"
    r"match(?:ing|es)?\b|disclos|suppression|\bquery\b|tokeniz|hash(?:ing)?\b|"
    r"identifier|federated|\bmpc\b|\bsmpc\b|\bpsi\b|algorithm|audit|aggregation|"
    r"probabilistic|data shar|data access|data use|data agreement|false positive|"
    r"false negative|pprl", re.I
)
LOGISTICS = re.compile(
    r"\b(?:nda|calendar|schedule|email|contract|signature|agenda|"
    r"invoice|travel|follow.up|zoom|grant needs)\b", re.I
)


def source_bytes(archive: Path) -> bytes:
    with ZipFile(archive) as outer:
        matches = [name for name in outer.namelist() if name.endswith(DOCX_NAME)]
        if len(matches) != 1:
            raise ValueError("Expected exactly one NYSED-MDI meeting notes document")
        return outer.read(matches[0])


def paragraphs(document: bytes):
    with ZipFile(BytesIO(document)) as docx:
        root = ET.fromstring(docx.read("word/document.xml"))
    for paragraph in root.findall(".//w:p", NS):
        value = "".join(node.text or "" for node in paragraph.findall(".//w:t", NS)).strip()
        if value:
            yield " ".join(value.split())


def chunk_text(values):
    # Keep one technical observation per chunk. Raw chronological grouping
    # mixed PET design discussion with unrelated meeting logistics.
    observations = [value for value in values if TECHNICAL.search(value) and not LOGISTICS.search(value)]
    return [{"id": f"meeting-{i:03d}", "text": text} for i, text in enumerate(observations, 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    destination = args.output.resolve()
    if destination.is_relative_to(repository) and not destination.is_relative_to(repository / "work"):
        parser.error("Private output must be outside the tracked repository, or in ignored work/")
    chunks = chunk_text(paragraphs(source_bytes(args.archive)))
    if not chunks or len(chunks) > 120:
        raise ValueError("Unexpected private notes size")
    payload = json.dumps({"version": 1, "chunks": chunks}, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode()) > 200_000:
        raise ValueError("Private notes object is too large")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", dir=args.output.parent, prefix=".private-notes-", delete=False, encoding="utf-8") as temp:
        os.chmod(temp.name, 0o600)
        temp.write(payload)
        temporary = temp.name
    os.replace(temporary, args.output)
    print(f"Prepared {len(chunks)} private chunks; content omitted from output.")


if __name__ == "__main__":
    main()
