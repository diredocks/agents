#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import collections
import json
import sys

import requests

from lms_common import (
    api_get,
    download_blob,
    ensure_session_persisted,
    list_pending_activities,
    resolve_session,
)


def pending_activities(args: argparse.Namespace) -> dict:
    pending_data = list_pending_activities(
        session=args.session,
        all_terms=args.all_terms,
        academic_year_id=args.academic_year_id,
        semester_id=args.semester_id,
    )
    courses = pending_data["courses"]
    selected_courses = pending_data["selected_courses"]
    term_info = pending_data["term_info"]
    items = pending_data["pending_items"]

    courses_counter = collections.Counter(item["course_id"] for item in items)
    pending_courses = [
        {"course_id": c.get("id"), "course_name": c.get("name"), "pending_activity_count": courses_counter[c.get("id")]}
        for c in selected_courses
        if courses_counter[c.get("id")] > 0
    ]
    pending_courses.sort(key=lambda x: (x["pending_activity_count"], x["course_name"]), reverse=True)

    return {
        "scope": {
            "all_terms": args.all_terms,
            "academic_year_id": args.academic_year_id,
            "semester_id": args.semester_id,
            "resolved_latest_term": term_info,
        },
        "summary": {
            "total_courses": len(courses),
            "selected_courses": len(selected_courses),
            "pending_activities": len(items),
            "pending_courses": len(pending_courses),
        },
        "pending_courses": pending_courses,
        "pending_activities": items,
    }


def list_terms(session: str) -> dict:
    courses = api_get("/api/my-courses", session).get("courses", [])
    terms: dict[tuple[int | None, int | None], dict] = {}

    for course in courses:
        ay = course.get("academic_year") or {}
        sem = course.get("semester") or {}
        key = (ay.get("id"), sem.get("id"))
        if key not in terms:
            terms[key] = {
                "academic_year_id": ay.get("id"),
                "academic_year_name": ay.get("name"),
                "academic_year_code": ay.get("code"),
                "semester_id": sem.get("id"),
                "semester_code": sem.get("code"),
                "semester_sort": sem.get("sort"),
                "course_count": 0,
            }
        terms[key]["course_count"] += 1

    items = list(terms.values())
    items.sort(
        key=lambda x: (
            int(x.get("academic_year_id") or -1),
            int(x.get("semester_sort") or -1),
            int(x.get("semester_id") or -1),
        ),
        reverse=True,
    )
    return {"total_courses": len(courses), "terms": items}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Minimal LMS API CLI")
    parser.add_argument(
        "-s",
        "--session",
        default=None,
        help="LMS session cookie (or LMS_SESSION env)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("courses", help="GET /api/my-courses")

    p_activities = subparsers.add_parser("activities", help="GET /api/courses/{id}/activities")
    p_activities.add_argument("course_id", type=int, help="Course ID")

    p_activity = subparsers.add_parser("activity", help="GET /api/activities/{id}")
    p_activity.add_argument("activity_id", type=int, help="Activity ID")

    p_upload = subparsers.add_parser("upload", help="GET /api/uploads/{id}")
    p_upload.add_argument("upload_id", type=int, help="Upload ID")

    p_download = subparsers.add_parser("download-ref", help="GET /api/uploads/reference/{id}/blob")
    p_download.add_argument("reference_id", type=int, help="Upload reference ID")
    p_download.add_argument("-o", "--output-dir", default="./downloads", help="Download directory")

    p_pending = subparsers.add_parser(
        "pending-activities",
        help="List pending activities (default: latest term only)",
    )
    p_pending.add_argument("--all-terms", action="store_true", help="Do not filter by latest term")
    p_pending.add_argument("--academic-year-id", type=int, help="Filter by academic_year.id")
    p_pending.add_argument("--semester-id", type=int, help="Filter by semester.id")

    subparsers.add_parser("terms", help="List academic years and semesters from my courses")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    session = resolve_session(args.session)
    if not session:
        print("error: missing session, use --session or LMS_SESSION", file=sys.stderr)
        return 1
    args.session = session

    ensure_session_persisted(args.session)

    try:
        if args.command == "courses":
            print(json.dumps(api_get("/api/my-courses", args.session), ensure_ascii=False, indent=2))
        elif args.command == "activities":
            print(
                json.dumps(
                    api_get(f"/api/courses/{args.course_id}/activities", args.session),
                    ensure_ascii=False,
                    indent=2,
                )
            )
        elif args.command == "activity":
            print(json.dumps(api_get(f"/api/activities/{args.activity_id}", args.session), ensure_ascii=False, indent=2))
        elif args.command == "upload":
            print(json.dumps(api_get(f"/api/uploads/{args.upload_id}", args.session), ensure_ascii=False, indent=2))
        elif args.command == "download-ref":
            path, _ = download_blob(args.reference_id, args.session, args.output_dir)
            print(path)
        elif args.command == "pending-activities":
            print(json.dumps(pending_activities(args), ensure_ascii=False, indent=2))
        elif args.command == "terms":
            print(json.dumps(list_terms(args.session), ensure_ascii=False, indent=2))
    except requests.RequestException as e:
        print(f"request failed: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
