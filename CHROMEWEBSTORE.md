# Chrome Web Store Listing — KitePlus Companion Extension

> Last Updated: 2026-06-16

## Store Listing

**Extension Name** [REQUIRED]
`KitePlus Companion Extension`

**Short Description** [REQUIRED]
`Intraday MTM charts, positions grouping, express baskets, and real-time charges directly on Zerodha Kite.`

**Detailed Description** [REQUIRED]
`Supercharge your Zerodha Kite trading experience with KitePlus Companion, a locally-running browser helper designed to improve your workflow, data visualization, and trade execution.

Key Features:
- Real-time Intraday MTM Chart: A beautiful, collapsible line chart injected directly into your Positions page showing profit/loss progression over time, high/low limits, and percentage change.
- Direct Capital Tracking: Fetches your Available Margin and Used Margin directly from Zerodha's backend margins API to display real-time capital percentage changes.
- Positions Grouping: Organize your active positions by underlying symbol or expiry date with nested P&L summaries.
- Express Baskets: Build and execute up to 8 F&O leg baskets simultaneously with immediate margin feedback.
- Watchlist Option Chains: Open interactive option chain tables directly within your watchlists for quick CE/PE order placements.
- Real-time Charges Calculator: Live estimation of GST, STT, and exchange fees in the order window before execution.

How to Use:
1. Log in to your Zerodha Kite account at kite.zerodha.com.
2. Navigate to the Positions tab to view your live Intraday MTM chart and grouping options.
3. Hover over watchlists to trigger the option chain overlay or build baskets in the sidebar.
4. Click on any chart node to inspect historical timestamps and P&L logs. Export historical logs as a CSV at any time.

Privacy & Safety:
KitePlus Companion runs 100% locally in your browser. All data stays on your machine and is never transmitted to any external server. We do not collect or share personal information, API keys, or financial credentials.`

**Category** [REQUIRED]
`Developer Tools` or `Productivity`

**Single Purpose** [REQUIRED]
`Provides custom MTM charting, positions grouping, and basket order execution utilities directly on the Zerodha Kite web interface.`

**Primary Language** [REQUIRED]
`English`

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |

### Screenshot Notes
- **Screenshot 1**: Show the Positions tab with the Intraday MTM Line Chart expanded, displaying a green/red graph, high/low percentage stats, and coordinates tooltip.
- **Screenshot 2**: Show the Positions Grouping view in action, showing positions sorted by underlying expiry dates.
- **Screenshot 3**: Show the watchlist option chain popup showing bids/asks and option strikes.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Used to persist intraday MTM history points locally on-device so that the chart is preserved across page refreshes. |
| `tabs` | permissions | Used to listen to tab updates so that the extension can identify when the user navigates between the Dashboard, Orders, Holdings, and Positions views on Kite. |
| `https://kite.zerodha.com/*` | host_permissions | Necessary to query Zerodha Kite's backend API (`/api/margins`) in the background to fetch the user's available cash and calculate capital percentages without page redirection. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

*KitePlus Companion processes all financial statistics locally. No data is stored off-device or transmitted to third parties.*

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [RECOMMENDED]
`https://[your-github-username].github.io/kiteplus-clone/privacy-policy.html`

## Distribution

**Visibility**: Public (or Unlisted if you only want to share it via link)
**Regions**: All regions (focused on India)
**Pricing**: Free

## Developer Info

**Publisher Name**: `[Your Name/Company]`
**Contact Email**: `[Your Email]`
**Support URL**: `https://github.com/[your-github-username]/kiteplus-clone/issues`

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-06-16 | Initial Release with MTM Canvas Chart, Margin Fetching, Grouping, and Baskets. | Draft |
