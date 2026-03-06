#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
from urllib.parse import unquote

import requests

BASE_URL = "https://lms.fdzcxy.edu.cn"


def get_env_file() -> str:
    # Keep env resolution tied to the runtime working directory.
    return os.path.join(os.getcwd(), ".env")


def get_env_session() -> str | None:
    env_file = get_env_file()
    if not os.path.exists(env_file):
        return None
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == "LMS_SESSION":
                    return value.strip().strip("\"'")
    except OSError:
        return None
    return None


def save_env_session(session: str) -> None:
    env_file = get_env_file()
    lines: list[str] = []
    found = False

    if os.path.exists(env_file):
        with open(env_file, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if line.strip().startswith("LMS_SESSION="):
                    lines.append(f"LMS_SESSION={session}")
                    found = True
                else:
                    lines.append(line)

    if not found:
        lines.append(f"LMS_SESSION={session}")

    with open(env_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")


def resolve_session(cli_session: str | None) -> str | None:
    return cli_session or os.getenv("LMS_SESSION") or get_env_session()


def ensure_session_persisted(session: str) -> None:
    if session and session != get_env_session():
        save_env_session(session)


def build_headers(session: str) -> dict:
    return {
        "Cookie": f"session={session}",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
    }


def api_get(path: str, session: str, timeout: int = 30) -> dict:
    resp = requests.get(f"{BASE_URL}{path}", headers=build_headers(session), timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def parse_filename(
    content_disposition: str,
    reference_id: int,
    fallback_name: str | None = None,
) -> str:
    filename = f"attachment_{reference_id}"
    if "filename=" in content_disposition:
        filename = content_disposition.split("filename=")[-1].strip("\"'")
        filename = unquote(filename)
        if filename.startswith("UTF-8''"):
            filename = filename[7:]
        return filename
    if fallback_name:
        return fallback_name
    return filename


def download_blob(
    reference_id: int,
    session: str,
    output_dir: str,
    fallback_name: str | None = None,
    overwrite: bool = True,
) -> tuple[str, bool]:
    url = f"{BASE_URL}/api/uploads/reference/{reference_id}/blob"
    resp = requests.get(url, headers=build_headers(session), stream=True, timeout=60)
    resp.raise_for_status()

    os.makedirs(output_dir, exist_ok=True)
    filename = parse_filename(resp.headers.get("Content-Disposition", ""), reference_id, fallback_name)
    filepath = os.path.join(output_dir, filename)

    if os.path.exists(filepath) and not overwrite:
        resp.close()
        return filepath, False

    with open(filepath, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)
    return filepath, True


def resolve_latest_term(courses: list[dict]) -> dict | None:
    if not courses:
        return None

    def term_key(course: dict) -> tuple[int, int, int]:
        ay = course.get("academic_year") or {}
        sem = course.get("semester") or {}
        return (int(ay.get("id") or -1), int(sem.get("sort") or -1), int(sem.get("id") or -1))

    latest = max(courses, key=term_key)
    ay = latest.get("academic_year") or {}
    sem = latest.get("semester") or {}
    return {
        "academic_year_id": ay.get("id"),
        "academic_year_name": ay.get("name"),
        "semester_id": sem.get("id"),
        "semester_code": sem.get("code"),
        "semester_sort": sem.get("sort"),
    }


def filter_courses_by_term(
    courses: list[dict],
    all_terms: bool = False,
    academic_year_id: int | None = None,
    semester_id: int | None = None,
) -> tuple[list[dict], dict | None]:
    selected_courses = courses
    term_info = None

    if not all_terms:
        term_info = resolve_latest_term(courses)
        if term_info is not None:
            selected_courses = [
                c
                for c in selected_courses
                if (c.get("academic_year") or {}).get("id") == term_info["academic_year_id"]
                and (c.get("semester") or {}).get("id") == term_info["semester_id"]
            ]

    if academic_year_id is not None:
        selected_courses = [
            c for c in selected_courses if (c.get("academic_year") or {}).get("id") == academic_year_id
        ]
    if semester_id is not None:
        selected_courses = [c for c in selected_courses if (c.get("semester") or {}).get("id") == semester_id]

    return selected_courses, term_info


def _normalize_submit_count(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def list_pending_activities(
    session: str,
    all_terms: bool = False,
    academic_year_id: int | None = None,
    semester_id: int | None = None,
) -> dict:
    courses = api_get("/api/my-courses", session).get("courses", [])
    selected_courses, term_info = filter_courses_by_term(
        courses,
        all_terms=all_terms,
        academic_year_id=academic_year_id,
        semester_id=semester_id,
    )

    items = []
    for course in selected_courses:
        course_id = course.get("id")
        activities = api_get(f"/api/courses/{course_id}/activities", session).get("activities", [])
        for activity in activities:
            if activity.get("is_closed", False):
                continue

            activity_id = activity.get("id")
            detail = api_get(f"/api/activities/{activity_id}", session)

            submit_count = _normalize_submit_count(detail.get("user_submit_count"))
            if submit_count is None:
                submit_count = _normalize_submit_count(activity.get("user_submit_count"))

            if submit_count is None:
                criterion = detail.get("completion_criterion_key") or activity.get("completion_criterion_key")
                if criterion != "submitted":
                    continue
                submit_count = 0

            if submit_count > 0:
                continue

            items.append(
                {
                    "course_id": course_id,
                    "course_name": course.get("name"),
                    "activity_id": activity_id,
                    "activity_title": detail.get("title") or activity.get("title"),
                    "activity_type": detail.get("type") or activity.get("type"),
                    "start_time": detail.get("start_time") or activity.get("start_time"),
                    "end_time": detail.get("end_time") or activity.get("end_time"),
                    "is_closed": detail.get("is_closed", activity.get("is_closed", False)),
                    "user_submit_count": submit_count,
                    "uploads": detail.get("uploads", []) or activity.get("uploads", []),
                }
            )

    items.sort(key=lambda x: ((x.get("end_time") or ""), x.get("course_name") or "", x.get("activity_id") or 0))

    return {
        "courses": courses,
        "selected_courses": selected_courses,
        "term_info": term_info,
        "pending_items": items,
    }
