# COZA — Zara Woman Tedarik İzleyici (PRD)

## Problem Statement
Turkish-language, COS-inspired minimalist mobile app (Expo/React Native) that tracks the
Zara Woman (ZW) collection from zara.com/tr. Scrapes products via a ScraperAPI proxy,
caches them in MongoDB, refreshes daily at 08:00 (Europe/Istanbul), and exposes an
e-commerce catalog with advanced filtering plus a minimal analytics dashboard.

## Architecture
- **Frontend:** Expo Router (tabs), TypeScript. Theme context (dark primary + light toggle),
  Auth + Favorites contexts, custom SVG donut + bar charts (react-native-svg),
  @gorhom/bottom-sheet filters, react-native-keyboard-controller, expo-image.
- **Backend:** FastAPI + Motor (MongoDB). JWT (bcrypt) email/password auth.
  APScheduler daily cron (08:00) + on-startup seed if catalog empty.
  ScraperAPI proxy (key in backend/.env) hitting Zara TR category JSON endpoints.
- **Data model:** products (name, price[TL], images, category, color, reference,
  display_reference, origin, supplier_code, seo_*), users, favorites, meta.
- **Origin/supplier:** derived deterministically from each product's genuine Zara
  reference code using Inditex's public sourcing-country distribution (stable per product;
  Zara TR public API does not expose per-product manufacturing origin). Labeled as a model in-app.

## User Personas
- Fashion supply-chain researcher tracking where ZW items are made.
- Conscious shopper filtering by manufacturing origin / supplier code.

## Core Requirements (static)
1. Scrape + analyze ZW products (name, price, images, category, origin, supplier code).
2. Standard categorization + filtering by origin & supplier code, search, price, sort.
3. Minimal pie/bar charts for origin & category distribution.
4. Turkish UI, dark/light studio modes.
5. JWT auth + per-user favorites.

## Implemented (2026-08-07)
- ScraperAPI pipeline over 16 curated ZW categories → 4451 products cached in Mongo.
- Daily 08:00 scheduler + startup seed + manual refresh endpoint.
- Auth (signup/login/me, JWT), Favorites CRUD (per-user, idempotent).
- Catalog: 2-col grid, category chip scroller, debounced search, filter bottom sheet
  (sort, origin, price range, supplier/style code), pagination, pull-to-refresh.
- Product detail: image pager, price, Üretim Yeri, Tedarikçi Kodu, Referans, favorite, Zara link.
- Analytics dashboard: KPIs, monotone donut (origin) + bar (category) charts.
- Profile: theme toggle, favorites count, data meta + manual refresh, logout.
- Backend 24/24 pytest pass; frontend flows verified. Fixed: filter sheet dismiss on tab blur.

## Backlog / Remaining
- P1: Real per-product manufacturing origin if a reliable source becomes available.
- P1: Price-drop / new-arrival tracking + history per product.
- P2: Supplier/factory drill-down screen (all products from one code).
- P2: iOS native tabs (Liquid Glass) on iOS 26.

## Next Tasks
- See Next Action Items in finish summary.
