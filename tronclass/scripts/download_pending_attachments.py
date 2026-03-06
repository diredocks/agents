#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import os
import sys

import requests

from lms_common import (
    download_blob,
    ensure_session_persisted,
    list_pending_activities,
    resolve_session,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download attachments for pending activities into attachments/<course_id>/<activity_id>/",
    )
    parser.add_argument("-s", "--session", default=None, help="LMS session cookie")
    parser.add_argument("--all-terms", action="store_true", help="Do not limit to latest term")
    parser.add_argument("--academic-year-id", type=int, help="Filter by academic_year.id")
    parser.add_argument("--semester-id", type=int, help="Filter by semester.id")
    parser.add_argument("--base-dir", default="attachments", help="Base output directory")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing files")
    args = parser.parse_args()

    session = resolve_session(args.session)
    if not session:
        print("error: missing session, use --session or LMS_SESSION", file=sys.stderr)
        return 1

    ensure_session_persisted(session)

    try:
        pending_data = list_pending_activities(
            session=session,
            all_terms=args.all_terms,
            academic_year_id=args.academic_year_id,
            semester_id=args.semester_id,
        )
        selected = pending_data["selected_courses"]
        pending_items = pending_data["pending_items"]

        pending_total = len(pending_items)
        downloaded_total = 0
        skipped_total = 0
        failed_total = 0

        for item in pending_items:
            course_id = item.get("course_id")
            activity_id = item.get("activity_id")
            uploads = item.get("uploads") or []
            if not uploads:
                continue

            out_dir = os.path.join(args.base_dir, str(course_id), str(activity_id))
            for upload in uploads:
                reference_id = upload.get("reference_id")
                if not reference_id:
                    continue
                fallback_name = upload.get("name") or f"attachment_{reference_id}"
                try:
                    path, downloaded = download_blob(
                        reference_id=int(reference_id),
                        session=session,
                        output_dir=out_dir,
                        fallback_name=fallback_name,
                        overwrite=args.overwrite,
                    )
                    if downloaded:
                        downloaded_total += 1
                        print(f"downloaded: {path}")
                    else:
                        skipped_total += 1
                        print(f"skipped: {path}")
                except requests.RequestException as e:
                    failed_total += 1
                    print(
                        f"failed: course={course_id} activity={activity_id} ref={reference_id} error={e}",
                        file=sys.stderr,
                    )

        print(
            f"summary: selected_courses={len(selected)} pending_activities={pending_total} downloaded={downloaded_total} skipped={skipped_total} failed={failed_total}"
        )
        return 0
    except requests.RequestException as e:
        print(f"request failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
