# Price book import report

Source: **Material cost + Labour cost book pricing .xlsx** (sheet "Sheet1"), 594 rows read.
Result: **548 items** imported into **122 products** (29 product families with several finishes, the rest single items).
Verification: all 548 imported items were checked again against the spreadsheet, cell by cell. Every product's price equals the spreadsheet TOTAL exactly. Names, hardware and labour values match exactly, and material matches except where a row's own TOTAL leaves material out (listed under conflicts). Nothing was rounded, renamed, merged or re-categorised.
Price tiers: Raw cost (spreadsheet price) 0%, Retail 57.5%, Builder 47%. Markups are only ever added by choosing a tier, and every job line shows the book price next to the sell price.

## How values were read

- Column A = item name (kept exactly, including spacing and spelling).
- B = material, C = hardware, D = factory, E = drafting, F = studio, H = install (dollars per unit). Column G has no heading and was empty.
- I = TOTAL. This is the product's price (single source of truth). Every product is priced at exactly this value.
- J = note (kept on the item as a note).
- Rows of one product (e.g. "Base Cabinet - …") are grouped as the finishes of one product, as in the current price book. Each row is still its own item with its own name and prices.

## Conflicts (12) – need a decision, not changed

| Row | Item | Issue |
|---|---|---|
| 258 | (no name) | Row 258 has prices (total 1165) but no description. Imported as unavailable until it is named. |
| 385 | White HMR laundry chute | TOTAL column is 745 (=SUM(D385:H385)) but the columns add up to 875. Priced at the spreadsheet TOTAL 745; material counted as 0 instead of 130. Please confirm which is right. |
| 646 | Wall Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained (3mm recess) | Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 647 | Wall Cabinet - 27mm Farmers Doors Weathered Slimline Oak Stained (8mm recess) | Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 648 | Wall Cabinet - 19mm Farmers Doors Bleached American Oak (40mm Shaker in Matching Veneer & Farmers water based coating) | Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 649 | Wall Cabinet - 19mm Farmers Doors BORD Verdi Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 650 | Wall Cabinet - 19mm Farmers Doors Elton Romano Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | Named "Wall Cabinet" but listed under "Tall cabinets up to 650mm d x 2700mm h - including 30mm shadowline" with tall cabinet prices. Imported under Tall cabinet as listed. |
| 590 | Wall Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained (3mm recess) | The same name appears on rows 590, 646 with different costs (1296 / 2317). All imported; please confirm which is right. |
| 591 | Wall Cabinet - 27mm Farmers Doors Weathered Slimline Oak Stained (8mm recess) | The same name appears on rows 591, 647 with different costs (1338 / 2397). All imported; please confirm which is right. |
| 592 | Wall Cabinet - 19mm Farmers Doors Bleached American Oak (40mm Shaker in Matching Veneer & Farmers water based coating) | The same name appears on rows 592, 648 with different costs (1250 / 2041). All imported; please confirm which is right. |
| 593 | Wall Cabinet - 19mm Farmers Doors BORD Verdi Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | The same name appears on rows 593, 649 with different costs (1281 / 2115). All imported; please confirm which is right. |
| 594 | Wall Cabinet - 19mm Farmers Doors Elton Romano Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | The same name appears on rows 594, 650 with different costs (1300 / 2153). All imported; please confirm which is right. |

## Duplicates (5) – all copies imported

| Name | Rows | Costs | Same price? |
|---|---|---|---|
| Wall Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained (3mm recess) | 590, 646 | $1296.00 / $2317.00 | No |
| Wall Cabinet - 27mm Farmers Doors Weathered Slimline Oak Stained (8mm recess) | 591, 647 | $1338.00 / $2397.00 | No |
| Wall Cabinet - 19mm Farmers Doors Bleached American Oak (40mm Shaker in Matching Veneer & Farmers water based coating) | 592, 648 | $1250.00 / $2041.00 | No |
| Wall Cabinet - 19mm Farmers Doors BORD Verdi Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | 593, 649 | $1281.00 / $2115.00 | No |
| Wall Cabinet - 19mm Farmers Doors Elton Romano Reconstituted Veneer (40mm Shaker in Matching Veneer & Farmers water based coating) | 594, 650 | $1300.00 / $2153.00 | No |

## Items with no price (2) – imported, switched off until priced

- Row 137: Base End Panel - 25mm Farmers Doors Weathered Slimline Oak Stained (8mm recess)
- Row 309: Hafele Wall Bed Bettlift without mattress (Art 271.92.132)

## Items with a total only (5) – the total is used as a lump-sum cost

- Row 361: Integration Service - Single fridge or freezer – $800.00
- Row 362: Integration Service - French door fridge (F&P) – $1100.00
- Row 363: Integration Service - Dishwasher 60cm – $600.00
- Row 364: Integration Service - Dishdrawer – $650.00
- Row 365: Hafele Technician call out to factory to set up hardware with factory team (Must for Bifold pocket system) – $600.00

## Text in a price column (2) – kept as a note, value $0.00

- Row 32, column B (Material): "Mitred BH Rate"
- Row 332, column B (Material): "laminate price"

## Rows that are not products

- Row 1: title "ITEM by QTY"
- Row 505: title "CHARGED BY LM"
- Row 386: note "*Cabinets to conceal chute is an additional cost" (added to the description of "White HMR laundry chute")

## Side notes and workings outside the price columns (39) – not imported as products

- Row 3: R: Polyurethane and sating cositngs \| S: 18mm x 3600 x 1200 \| T: 21mm x 3600 x 1200
- Row 4: R: Board costings \| S: 72 \| T: 117 \| U: Per sheet
- Row 5: R: Board costings \| S: 17 \| T: 28 \| U: Per sheet M2
- Row 6: R: Spraying \| S: 85 \| T: 85 \| U: Per sheet M2
- Row 7: R: Factory preperation \| S: 30 \| T: 30 \| U: Per sheet M2
- Row 8: S: 132 \| T: 143
- Row 9: R: Shaker machine time \| S: 30 \| T: 30 \| U: Per sheet M2
- Row 10: R: Spraying shaker work \| S: 40 \| T: 40
- Row 11: S: 202 \| T: 213
- Row 535: K: 1. FARMERS Bleached American Oak:
- Row 536: K: Base door 500 x 880 = $276
- Row 537: K: Wall door 500 x 1000 = $316
- Row 538: K: Tall door 500 x 2300 = $632
- Row 540: K: 1. BORD Verdi Reconstituted Veneer: MR MDF 3000x1200x19mm G2S - $108.00m2 + GST
- Row 541: K: Base door 500 x 880 = $290
- Row 542: K: Wall door 500 x 1000 = $332
- Row 543: K: Tall door 500 x 2300 = $669
- Row 545: K: 1. ELTON Romano Reconstituted Veneer:
- Row 546: K: Base door 500 x 880 = $297
- Row 547: K: Wall door 500 x 1000 = $341
- Row 548: K: Tall door 500 x 2300 = $688
- Row 550: K: Farmers workings
- Row 551: K: $75 for 4x hinges allowed for
- Row 552: K: $55 for hmr carcass material
- Row 619: K: 1. FARMERS Bleached American Oak:
- Row 620: K: Base door 500 x 880 = $276
- Row 621: K: Wall door 500 x 1000 = $316
- Row 622: K: Tall door 500 x 2300 = $632
- Row 624: K: 1. BORD Verdi Reconstituted Veneer: MR MDF 3000x1200x19mm G2S - $108.00m2 + GST
- Row 625: K: Base door 500 x 880 = $290
- Row 626: K: Wall door 500 x 1000 = $332
- Row 627: K: Tall door 500 x 2300 = $669
- Row 629: K: 1. ELTON Romano Reconstituted Veneer:
- Row 630: K: Base door 500 x 880 = $297
- Row 631: K: Wall door 500 x 1000 = $341
- Row 632: K: Tall door 500 x 2300 = $688
- Row 634: K: Farmers workings
- Row 636: K: $75 for 4x hinges allowed for
- Row 637: K: $55 for hmr carcass material
