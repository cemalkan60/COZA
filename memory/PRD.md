# COZA — Zara Woman Tedarik İzleyici (PRD)

## Data source
- Catalog scraped from **zara.com/es/en** (Spain store): English product names, EUR (€) prices.
- REAL manufacturing origin ("Made in X") + composition from ES `extra-detail` endpoint.
- Origin cached per 4-digit `manufacturer_code` in `db.origins`; enriched in a background
  job after each scrape (per-code representative product; concurrency 5). ~1000 codes.
- Daily 08:00 (Europe/Istanbul) auto-scrape + incremental origin enrichment.

## Roles / Auth (JWT, bcrypt, plain-string identifier)
- Admin (proxy key + storage settings + manual scrape): admin@still / cozaadmin2026
- Viewers (read-only, 403 on admin routes): ece@still / berilberen, cem@still / cem123
- Public signup creates viewers.

## Frontend (Expo Router)
- **Drawer** navigation (hamburger LEFT of COZA logo) replaced bottom tabs. Drawer =
  nav (Katalog/Yeni/Analiz/Favoriler/Profil) + KATEGORİLER + ÜRETİM YERİ (selecting filters catalog).
- Catalog: comprehensive search (name/category/origin/color/code), no filter pill, no chip row,
  active-filter chips, infinite scroll. Cards show real origin + tappable manufacturer code.
- Yeni Gelenler ('YENİ' badge), Favoriler, Compare (2 products incl. composition), Factory detail.
- Analiz: Üretici Analizi (manufacturer search + per-code origin donut/category bar/KPIs) + Genel Bakış.
- Theme dark/light toggle. Minimal COZA wordmark logo (tap → home).

## Key backend endpoints
- /auth/{signup,login,me}; /products (filters: category, origin, code, q, is_new, price, sort);
  /products/{id}; /products/{id}/composition; /filters; /analytics;
  /manufacturers?q=; /analytics/manufacturer/{code}; /meta;
  /admin/scrape, /admin/settings (admin only).

## Status (2026-08-07, iter 3)
- BUG FIXED (verified by testing_agent): origin now REAL from zara.es — code 5216 = Türkiye (was Fas).
- Backend 16/16 pytest pass; all frontend flows verified.

## Backlog
- DONE: origin enrichment now tries up to 5 products per code + on-demand
  admin endpoint `/admin/enrich-origins`. Pending codes 79→39 (remaining are
  delisted 404 products; clear automatically on next daily scrape).
- DONE: removed dead FilterSheet + @gorhom/bottom-sheet provider (React-19
  pointerEvents warning source). Drawer-only nav; no bottom-sheet usage left.
