# Price integrity report

Company: **Vicello Kitchens (demo)** · price book: **Material + Labour cost book (Oct 2026)** · spreadsheet: **Material cost + Labour cost book pricing .xlsx** · checked 28/10/2026, 9:46:40 pm

For every product: the spreadsheet price (TOTAL column), the price stored in the database, and the price the program
calculates on a quote for 1 and 5 units with no markup. All three must be equal.

| Check | Result |
|---|---|
| Spreadsheet products | 548 |
| Exact matches (spreadsheet = database = quote) | 536 |
| Price mismatches | 0 |
| Missing from the price book | 0 |
| In the price book but not the spreadsheet | 0 |
| Duplicate names (each copy counted) | 10 |
| Mapping / name issues | 1 |
| Spreadsheet rows to check (columns ≠ TOTAL) | 1 |

Price tiers (markup is only ever added by the tier chosen on a job, and is shown on every line): Retail 57.5% (default), Builder 47%, Raw cost (spreadsheet price) 0%.

## Products to look at (12)

| Row | Product | Spreadsheet | Database | Quote ×1 | Quote ×5 | Result | Notes |
|---|---|---|---|---|---|---|---|
| 258 | (no description – row 258) | $1165.00 | $1165.00 | $1165.00 | $5825.00 | Mapping issue | Row 258 has prices (total 1165) but no description. Imported as unavailable until it is named. · Switched off in the price book |
| 385 | White HMR laundry chute | $745.00 | $745.00 | $745.00 | $3725.00 | Check spreadsheet row | TOTAL column is 745 (=SUM(D385:H385)) but the columns add up to 875. Priced at the spreadsheet TOTAL 745; material counted as 0 instead of 130. Please confirm which is right. |
| 590 | Wall Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained (3mm recess) | $1296.00 | $1296.00 | $1296.00 | $6480.00 | Duplicate name | Same name appears more than once in the spreadsheet |
| 591 | Wall Cabinet - 27mm Farmers Doors Weathered Slimline Oak Stained (8mm recess) | $1338.00 | $1338.00 | $1338.00 | $6690.00 | Duplicate name | Same name appears more than once in the spreadsheet |
| 592 | Wall Cabinet - 19mm Farmers Doors Bleached American Oak (40mm Shaker in Matching Veneer & Farmers water based coating) | $1250.00 | $1250.00 | $1250.00 | $6250.00 | Duplicate name | Same name appears more than once in the spreadsheet |
| 593 | Wall Cabinet - 19mm Farmers Doors BORD Verdi Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | $1281.00 | $1281.00 | $1281.00 | $6405.00 | Duplicate name | Same name appears more than once in the spreadsheet |
| 594 | Wall Cabinet - 19mm Farmers Doors Elton Romano Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | $1300.00 | $1300.00 | $1300.00 | $6500.00 | Duplicate name | Same name appears more than once in the spreadsheet |
| 646 | Wall Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained (3mm recess) | $2317.00 | $2317.00 | $2317.00 | $11585.00 | Duplicate name | Same name appears more than once in the spreadsheet · Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 647 | Wall Cabinet - 27mm Farmers Doors Weathered Slimline Oak Stained (8mm recess) | $2397.00 | $2397.00 | $2397.00 | $11985.00 | Duplicate name | Same name appears more than once in the spreadsheet · Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 648 | Wall Cabinet - 19mm Farmers Doors Bleached American Oak (40mm Shaker in Matching Veneer & Farmers water based coating) | $2041.00 | $2041.00 | $2041.00 | $10205.00 | Duplicate name | Same name appears more than once in the spreadsheet · Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 649 | Wall Cabinet - 19mm Farmers Doors BORD Verdi Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | $2115.00 | $2115.00 | $2115.00 | $10575.00 | Duplicate name | Same name appears more than once in the spreadsheet · Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 650 | Wall Cabinet - 19mm Farmers Doors Elton Romano Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | $2153.00 | $2153.00 | $2153.00 | $10765.00 | Duplicate name | Same name appears more than once in the spreadsheet · Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |

The full product-by-product list (548 rows) is in the CSV file with the same name.
