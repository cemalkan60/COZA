# COZA — Zara Woman Tedarik İzleyici (PRD)

## Problem Statement
Turkish COS-inspired minimalist Expo app tracking the Zara Woman (ZW) collection from
zara.com/tr. Scrapes via ScraperAPI proxy, caches in MongoDB, refreshes daily 08:00,
e-commerce catalog + advanced filtering + minimal analytics + roles.

## Architecture
- Frontend: Expo Router. Theme (dark/light toggle), Auth + Favorites + Compare contexts,
  SVG donut/bar charts, @gorhom/bottom-sheet filters, keyboard-controller, expo-image.
- Backend: FastAPI + Motor. JWT (bcrypt) auth with ROLES (admin/viewer). APScheduler daily
  08:00 cron + startup seed. Settings collection for admin-editable proxy key.
- Data: products (name, price, images, category, color, reference, display_reference,
  full_code, manufacturer_code(=first 4 digits of code), supplier_code, origin, is_new),
  users(role), favorites, settings, meta.
- Origin derived deterministically from manufacturer_code via Inditex sourcing distribution.

## Users / Roles
- Admin (full: proxy key + storage settings + manual scrape): admin@still / cozaadmin2026
- Viewers (read-only): ece@still / berilberen, cem@still / cem123
- Public signup creates viewers. Login identifier is plain string (non-email usernames allowed).

## Implemented
- Iter 1: scraper pipeline (16 ZW categories, ~4430 products), daily scheduler, JWT auth,
  favorites, catalog grid + chips + search + filter sheet, PDP, analytics dashboard,
  profile theme toggle.
- Iter 2 (2026-08-07):
  - Redesigned minimal COZA wordmark logo (COS/Zara style), tappable → home.
  - Minimal login/signup (no hero photo, no brand taglines, faint watermark).
  - Catalog header: Filtrele button LEFT + search magnifier icon.
  - Manufacturer code = first 4 digits of code; searchable (q & code prefix match); tappable.
  - RBAC: admin + 2 viewers, seeded idempotently; admin-only proxy/storage settings + scrape (403 for viewers).
  - Factory Detail screen (tap code → all products of that code).
  - New Arrivals 'Yeni' tab + YENİ badge.
  - Compare screen (2 products: price, origin, code, full code, category, color, live composition).
  - Backend 39/39 pytest pass; all frontend flows verified.

## Backlog
- P1: real per-product origin if a reliable source appears; price-drop history.
- P2: bump @gorhom/bottom-sheet to silence React-19 pointerEvents warning.
