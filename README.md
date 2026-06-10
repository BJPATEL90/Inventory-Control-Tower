# Inventory Control Tower

Enterprise-grade inventory monitoring system built on Google Apps Script + GitHub Pages.

---

## Phase 1 — Backend Data Model ✅

This phase delivers:
- `Config.gs` — All constants, column definitions, settings engine
- `Code.gs` — Sheet initializer, daily orchestrator, shared utilities

Phases 2–8 will be delivered sequentially.

---

## Architecture

```
Gmail Attachments
      ↓
Google Apps Script (Backend)
      ↓
Google Sheets (Database)
      ↓
Apps Script Web App (JSON APIs)
      ↓
GitHub Pages (Dashboard)
      ↓
Management Email (Automated)
```

---

## Phase 1 Setup Instructions

### Step 1 — Create a New Google Spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com)
2. Create a new blank spreadsheet
3. Name it: `Inventory Control Tower`

---

### Step 2 — Open Apps Script Editor

1. In the spreadsheet: **Extensions → Apps Script**
2. Delete the default `Code.gs` content
3. Create the following files (click `+` next to Files):

| File | Content |
|------|---------|
| `Config.gs` | Paste contents of `apps-script/Config.gs` |
| `Code.gs` | Paste contents of `apps-script/Code.gs` |

> Phases 2–8 will add more `.gs` files. Do not create placeholders yet.

---

### Step 3 — Run First-Time Setup

1. Save all files (Ctrl+S)
2. In the editor, select function `setupSpreadsheet` from the dropdown
3. Click **Run**
4. Grant permissions when prompted (Google will ask for Sheets + Gmail + Calendar access)
5. Return to your spreadsheet — you should now see 12 sheets created

---

### Step 4 — Configure Settings

Open the `tbl_settings` sheet and update these critical values:

| Setting Key | What to Enter |
|-------------|--------------|
| `email_recipients` | `person1@company.com, person2@company.com` |
| `email_sender_filter` | Part of the sender's email that identifies report emails |
| `email_subject_filter` | Keyword in the subject line of report emails |
| `fg_attachment_keyword` | Part of the FG Inventory CSV filename |
| `shelf_attachment_keyword` | Part of the Shelf Inventory CSV filename |
| `dashboard_url` | Your GitHub Pages URL (fill after Phase 5) |
| `allowed_domains` | `yourdomain.com` |
| `oauth_client_id` | Your Google OAuth Client ID (fill after Phase 6) |

---

### Step 5 — Upload Bin Master

1. Open `tbl_bin_master` sheet
2. Paste your bin master data starting from row 2
3. Columns: `Bin ID | Row | Column No | Level`

> This is a one-time upload. Re-upload only when bin layout changes.

---

### Step 6 — Configure COGS Master

1. Open `tbl_cogs_master` sheet
2. Delete the example placeholder row
3. Paste your COGS data:

| SKU Code | Product Name | Brand | COGS |
|----------|-------------|-------|------|
| MWMMHRP.0001... | Product Name | Brand | 112.57 |

> Any SKU missing from this sheet will fall back to Cost Price from the FG report and be flagged.

---

### Step 7 — Verify Setup

1. In the spreadsheet menu: **🏭 Inventory Tower → 📊 Verify Sheet Structure**
2. All sheets should show ✅

---

## Sheet Reference

| Sheet | Purpose | Data Source |
|-------|---------|-------------|
| `tbl_fg_inventory_raw` | Raw FG inventory CSV data | Gmail attachment (auto) |
| `tbl_shelf_inventory_raw` | Raw shelf inventory CSV data | Gmail attachment (auto) |
| `tbl_bin_master` | Warehouse bin layout | Manual upload |
| `tbl_cogs_master` | Cost of goods sold master | Manual maintenance |
| `tbl_facility_mapping` | Facility type configuration | Pre-seeded, admin editable |
| `tbl_sku_summary` | Computed per-SKU aggregates | Calculated daily |
| `tbl_inventory_health` | DOI bucket summary | Calculated daily |
| `tbl_expiry_summary` | Expiry risk details | Calculated daily |
| `tbl_warehouse_utilization` | SL_MH bin utilization | Calculated daily |
| `tbl_dashboard_summary` | KPI snapshot for APIs | Calculated daily |
| `tbl_email_summary` | Email send log | Auto-logged |
| `tbl_settings` | System configuration | Admin managed |

---

## Inventory Logic Reference

### DOI Calculation
```
DRR30 = Last 30 Days Sales ÷ 30
DRR7  = Last 7 Days Sales ÷ 7
DOI30 = SOH ÷ DRR30
DOI7  = SOH ÷ DRR7
```
> SOH only. SIT is excluded from DOI.

### Health Buckets
| Bucket | Condition |
|--------|-----------|
| OOS | SOH = 0 |
| Critical | DOI < 7 |
| Risk | DOI 8–30 |
| Healthy | DOI 31–90 |
| Overstock | DOI > 90 |

### Good vs Bad Inventory
| Type | Conditions |
|------|-----------|
| Good | Inventory Type = GOOD_INVENTORY AND Batch Status = Active AND Expiry > Today |
| Bad | Inventory Type = BAD_INVENTORY OR Qty Damaged > 0 OR Qty Not Found > 0 OR Batch Status ≠ Active OR Expiry < Today |

### Expiry Buckets
| Bucket | Condition |
|--------|-----------|
| Near Expiry | Expiry ≤ 60 days |
| Critical Expiry | Expiry ≤ 30 days |
| Expired | Expiry < Today |

### Inventory Valuation
```
Always use COGS Master. Never use "Inventory Value on CP" from FG report.
Inventory Value     = SOH × COGS
Good Inventory Value = Good Qty × COGS
Bad Inventory Value  = Bad Qty × COGS
Near Expiry Value   = Near Expiry Qty × COGS
Expired Value       = Expired Qty × COGS
Value At Risk       = Bad Value + Near Expiry Value + Expired Value
```

### Bin Utilization (SL_MH ONLY)
```
Occupied = Bin in Bin Master AND inventory exists in shelf data for SL_MH
Empty    = Bin in Bin Master AND no inventory in shelf data for SL_MH
Utilization % = Occupied Bins ÷ Total Bins × 100
```

### Sales for Mother Warehouse DOI
```
Mother Warehouse Sales = Sum of all Sales Node facilities
(SL_MM + SL_LJ + SL_BW + SL_B2B + SL_OFF + any future Sales Node)
```

---

## Coming in Phase 2

**Gmail Processing** (`GmailProcessor.gs`)
- Reads Gmail for FG + Shelf inventory CSV attachments
- Validates attachment format
- Imports to raw tables
- Handles duplicate detection

---

## File Structure (Complete — all phases)

```
inventory-control-tower/
├── apps-script/
│   ├── Config.gs              ✅ Phase 1
│   ├── Code.gs                ✅ Phase 1
│   ├── GmailProcessor.gs         Phase 2
│   ├── InventoryProcessor.gs     Phase 3
│   ├── API.gs                    Phase 4
│   ├── Auth.gs                   Phase 6
│   ├── EmailReport.gs            Phase 7
│   └── Config.gs (updated)       Phase 8
├── css/
│   └── styles.css                Phase 5
├── js/
│   ├── api.js                    Phase 5
│   ├── app.js                    Phase 5
│   ├── dashboard.js              Phase 5
│   ├── inventoryHealth.js        Phase 5
│   ├── expiry.js                 Phase 5
│   ├── utilization.js            Phase 5
│   ├── skuDeepDive.js            Phase 5
│   ├── motherWarehouse.js        Phase 5
│   └── settings.js               Phase 5
├── index.html                    Phase 5
└── README.md                  ✅ Phase 1
```
