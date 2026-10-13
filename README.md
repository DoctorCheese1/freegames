# Free Games Discord Bot — MJS v2.5

## Setup and update
Requires Node.js 24.17+. Install it from https://nodejs.org, extract the ZIP, and copy .env.example to .env. Add DISCORD_TOKEN; optional DISCORD_GUILD_ID is your server ID, not a channel/application ID. Blank means global commands. STEAM_COUNTRY defaults to US. Invite your dedicated bot application using bot and applications.commands scopes with View Channel, Send Messages, Embed Links and Attach Files. No Administrator or privileged intents needed.

To update: stop the bot, replace the supplied files, keep your existing .env and state.json, then double-click Start-Bot.bat. The first launch installs dependencies. Keep the computer and bot running for alerts. Do not run multiple copies. On Linux/Pi use npm install and npm start from this folder. npm test runs local tests without a token.

## Browse and track
- /free store:all — artwork cards for normally paid games currently offered free. Store counts, type dropdown, Previous/Next, claim link and Mark claimed button.
- /giveaways — same browser. page selects an offer number; /free also supports a title search.
- /deals — Steam games with defaults of 30% off, 80% positive reviews, 100 reviews. Supports search, page, min_discount, min_positive and min_reviews. Personal presets from /settings are used unless explicitly overridden.
- /stores — supported giveaway stores.
- /settings — private panel for favorite stores, deal presets, showing/hiding claimed offers and enabling/disabling wishlist DMs.
- /preferences keywords:survival,co-op — filter offer titles/descriptions by any matching word; use all to clear. Genre words are keyword matching, not verified genre metadata.
- /claimed — number of offers manually marked claimed. /claimed action:clear resets tracking. Store ownership is not independently verified.
- /wishlist action:add name:Game Title — add a watched game name. Remove/list use the corresponding action. Up to 10 watched names per user. Enable wishlist DMs in /settings to receive alerts; off by default. This is a manual name watchlist, not a Steam-account wishlist import.

For you applies your favorite stores and keywords, hiding claimed offers by default. Store counts reflect the selected offer type after keyword/claimed filtering, before a title search; they describe the current cached feed. Each user should open their own browser. Browser sessions expire after 24 hours or a restart. Profile settings, claimed IDs, watchlists and alert history persist in state.json.

## Automatic posts and separate channels
Manage Server permission is required. Checks run at startup and every 30 minutes.

- /alerts channel:#free-games store:all — configure free-game posts with default six-hour expiry reminders.
- /configure type:game channel:#free-games store:all reminder_hours:6
- /configure type:loot channel:#free-dlc store:all reminder_hours:6
- /configure type:deals channel:#game-deals min_discount:50 min_positive:90 min_reviews:500
- /configure type:loot enabled:false — disable one stream.
- /stopalerts — disable all server streams.

One channel per type per server; each stream has its own history. Current offers post after configuration; reconfiguration resets that stream's history. /alerts replaces the configured free-game stream while retaining other streams. Automatic Steam deals examine the first 20 sale candidates, display up to ten qualifying games, and post again only when discount/price changes to a previously unposted combination. They do not exhaustively scan every sale. DLC offers can require owning the base game.

Expiry reminders are sent once per offer per stream when its reported end time is within the configured lead time. The source doesn't specify a timezone; UTC is assumed and stated in reminder messages. Unknown dates don't get reminders. Confirm deadlines on the claim page. Checks every 30 minutes can miss short-lived offers; nothing is sent while the host is off. Sent messages are not edited when offers expire. Crash timing can cause occasional duplicate posts.

Wishlist matching uses title substring matches. Free matches span supported stores; discount matches use the first 20 Steam search candidates and your deal filters. At most 10 watched names are checked per cycle, rotating across users, so large servers can have longer delays. Up to three matching discounts per watched name are sent. DMs must be enabled in Discord. Disable them in /settings to opt out. Failed delivery is retried in later checks. Wishlist matches and source coverage can miss offers or match similarly named games.

## Sources and limits
Steam, Epic Games Store, GOG, itch.io, DRM-free, PC, Xbox One/Series X/S, Nintendo Switch, Android and iOS giveaway filters are supported through GamerPower. PlayStation is excluded, including cross-platform offers. Other PC services can appear when reported; no dedicated EA, Ubisoft, Battle.net or Prime Gaming integration is included.

Full-game giveaways require Active Game offers and a positive source-reported retail value. Zero/unknown values are excluded, possibly missing legitimate giveaways. This isn't an independently verified price history or a guarantee of permanent ownership. Limited keys, external account requirements, region restrictions and temporary access may apply. The optional DLC filter accepts source-reported free loot/add-ons without requiring a known retail value.

/deals uses all-language, all-purchase-type Steam review summaries; percentages may differ from the displayed store rating. Each source page has 20 candidates; filtering can leave no results. Prices depend on STEAM_COUNTRY and may change before purchase. Missing review data is omitted. Steam's public search endpoint is undocumented and can change.

Claim links open in your browser; finish redemption while signed into the appropriate store. The bot does not store store-account credentials or automatically redeem games.

## Startup diagnostics
50001: Missing access. Confirm DISCORD_GUILD_ID is the server the bot joined, or leave it blank. Reinvite with bot and applications.commands scopes. 50013: check bot/channel permissions. Invalid token: update .env from the Developer Portal. Server-ID mismatches now produce a specific explanation. Command registration replaces this application's command set in the configured scope, so use a dedicated bot application. See bot.log for errors.

## Validation and attribution
Syntax and 16 local fixture/integration tests pass. Live Discord login, message delivery and real offer feeds were not tested with a user token.
Giveaways powered by [GamerPower](https://www.gamerpower.com) — https://www.gamerpower.com/api-read
Steam reviews: https://partner.steamgames.com/doc/store/getreviews
Libraries: https://discord.js.org and https://cheerio.js.org

## Account install and group DMs (v2.5)
1. Open https://discord.com/developers/applications and select the application whose Bot token is in your .env.
2. Open Installation. Enable BOTH Guild Install and User Install in Installation Contexts. Under User Install default settings select applications.commands. Keep bot + applications.commands for Guild Install. Save.
3. Replace the supplied files while preserving .env and state.json, then restart. Commands are now registered globally even when DISCORD_GUILD_ID is set; server commands are also synced for that configured server.
4. The console prints an account installation URL, also saved as Account-Install-Link.txt. Open that URL and approve installing the app to your account. If Discord shows a choice, choose Add to My Apps/account rather than Add to Server.
5. Open your group DM, type /free or /deals and select this app. Global commands can take time to propagate; reload Discord if needed. Keep the bot process running.

/free, /giveaways, /deals, /stores, /settings, /preferences, /wishlist and /claimed support account installation in servers, personal DMs and group DMs. /alerts, /configure and /stopalerts remain server-only. Personal panels and wishlists are private replies; game card replies are public to the conversation where Discord allows them. The app responds to your command without joining the group as a normal bot member. Each user should install the app to open their own browser. Settings and marked-claimed history remain per user.

This enables command-triggered group-DM replies, not scheduled group-DM posting. Automatic server alerts and opt-in personal wishlist DMs remain as before. It cannot fetch a group DM simply by channel ID. User-install responses respect Discord restrictions; servers may force external-app responses private. If registration produces 50035, verify both installation contexts are enabled in the portal. Do not share your token; account install links do not contain it.

Validation: 17 local tests pass, including explicit user-install/private-channel command contexts. Live group-DM installation and posting were not tested with your Discord account.

## Interaction timeout fix (v2.5.1)
All slash commands now defer their initial reply immediately, before settings/state work. Private commands retain private responses. Discord error 10062 (Unknown interaction) can also occur if multiple copies use the same bot token, or connection/event-loop delays exceed the acknowledgement window. Stop every old bot process, then start only this version once. The fix cannot recover interactions that have already expired.

## Screenshot-style server panels (v2.5)
After configuring a channel, run /notificationsettings type:game (or loot/deals). The panel has Filters, Display, Notifications and More tabs.
- Filters: supported store selector, minimum reported original value ($0/$1/$3/$10), and an optional well-reviewed Steam filter. The latter requires a direct Steam app claim link and at least 80% positive / 100 reviews; non-Steam and unknown-rating offers are omitted. Price/quality panel filters apply to free-game and DLC streams; Steam deals use the numeric thresholds set with /configure.
- Display: nine themes, no threads/thread below/post inside a new thread, claim-link buttons, gift auto reaction and announcement auto publishing. Giveaway themes are applied to new giveaway posts; deals retain their price/review card. Threads apply to offer posts, not expiry reminders. Claim buttons never redeem automatically.
- Notifications: select a role, clear it or create a mentionable Free Games role. Creating roles requires Manage Roles for both manager and bot. Role pings are explicit opt-in and use a restricted allowed-mentions list.
- More: send a synthetic test without role pings, or reset history to resend current offers on the next scheduled check (which may ping the selected role).

Regular text and announcement channels are accepted by /configure and /alerts. Creating threads requires appropriate Create/Send in Public Threads permissions; reactions require Add Reactions and channel access; publishing requires an announcement channel and appropriate Discord permissions. Failed optional reactions/publishing are logged. New posts use updated options; old messages stay unchanged. Test posts are real posts in the configured server channel.

The /free browser has All claim links, listing up to 15 current links for manual redemption. It is not an auto-claim function. Private/group DM browsers remain supported; server notification settings cannot be used in group DMs.

Not included from the reference service: Prime Gaming, Game Pass, free-weekend subscription feeds, verified non-Steam ratings, custom bot avatars/names or dedicated Humble/Origin/Ubisoft store filters. Those require additional provider integrations or webhook branding. This bot does not imitate the FreeStuff branding.

Update supplied files, preserve .env and state.json and restart. 19 local tests pass; role creation, threads, announcements and real Discord display still need live verification.

## Settings navigation like the reference pictures (v2.5.1)
In a server, managers can run /settings for the Your Active Notifications home screen. Choose 100% Discount, DLCs & More or Steam Deals, then choose Filter Settings, Display Settings, Notification Settings or More. Each page has Back and Need help controls. Price presets have explanatory dropdown descriptions; display toggles show Enabled/Disabled states; role settings include Refresh List, Add Role and Clear Role; More shows Send Test and Resend. Discord determines exact menu spacing and placement.

/settings scope:personal keeps personal settings available. In private/group DMs the default remains personal settings. /notificationsettings opens the server home; optionally specify type to open one category. Configure channels with /configure first. Unsupported sources and custom branding remain unavailable, as documented above.

## Direct store readers (v2.6)
Steam full-game free offers now come from Steam store search (100% discount candidates) and are verified against appdetails: game type, positive original price, zero final price and 100% discount. /free store:steam no longer relies on GamerPower. Permanently free games are excluded. Up to ten 100-result candidate pages are scanned.

Epic full-game offers use Epic’s freeGamesPromotions endpoint with active promotion dates, positive original price and zero discounted price. GOG uses its catalog endpoint, filtering normally paid games with positive base price and zero final price. Store readers are region-sensitive and cached five minutes. The direct readers use public endpoints that can change. Epic/GOG live endpoints could not be inspected from the build environment; they are implementations tested with fixture responses, not live-verified integrations. GOG catalog-only discovery may miss homepage giveaway campaigns that aren't represented as zero-priced catalog products.

Cards label the source explicitly. Other platforms and DLC/loot remain GamerPower-feed based; direct integrations for every listed service are not complete. No ratings, prices or expiration times are invented when missing. Unknown deadlines have no expiry reminder. If a direct source or its verification fails, the command reports a source error instead of silently substituting a feed. The All-platform list currently requires all direct readers to succeed. Use an individual store filter when another source is unavailable.

Steam, Epic and GOG direct IDs have store prefixes, so previously posted feed offers may post once again after updating. Preserve .env and state.json. 22 local tests are included; live Discord and direct-store endpoints still require testing on your host.

## Prime Gaming and Game Pass access (v2.6.1)
/prime opens an Amazon membership-claim card linking to https://luna.amazon.com/claims/ (gaming.amazon.com currently redirects there). /gamepass opens Xbox’s official catalog with plan/region guidance. Both commands support user install/group DMs. Server notification home has separate Prime Gaming and Game Pass buttons, which open private subscription cards.

These are official-site access categories only: automatic catalog ingestion and new-title notifications are not implemented. The official pages require browser JavaScript and/or account context and did not expose a reliable full catalog during verification. Subscription categories are not presented as public free-to-keep offers. Existing free/deal sources and notifications are unchanged.

## Multiple server store filters (v2.6.2)
Filter Settings > Only from these stores now accepts multiple selections. Selected stores are combined and duplicate offer IDs are removed. All platforms overrides individual choices. The choices persist in state.json and apply to new free-game/DLC posts. Existing single-store settings remain compatible. Steam deals remain Steam-only.

## Free Weekend (v2.7)
The /free type dropdown now includes Free Weekend. Configure automatic posts using /configure type:weekend channel:#free-weekends store:steam. The category appears on the settings home after configuration, with the same filters/display controls.

Source: Steam’s featured catalog and first sale-search page provide up to 100 candidate games. Each normally paid game’s live purchase section is checked for free-play/ends markers. Matches are labeled temporary access, never free to keep. This is a bounded best-effort scan, not exhaustive discovery; age gates, region limits, page changes and failed checks may hide offers. Partial failures are logged. Other stores are not supported for this category. Exact expiry is displayed as “check Steam” when unavailable; no countdown/reminder is invented. First scan can take up to a few minutes. Local fixtures cover detection; live offers remain unverified.

## Live GitHub updates (v2.8)
Use Start-Bot.bat or npm start to run the supervising run.mjs launcher. It checks DoctorCheese1/freegames main at startup and every 30 minutes. The exact allowlist of program files is staged at an immutable commit, blob hashes and JavaScript syntax are checked, then the bot stops, files are backed up/replaced, changed dependencies are installed with scripts disabled, and the bot restarts. Failed application/install attempts restore program backups. The running supervisor itself loads changes next time the launcher restarts.

.env, state.json, stat.json, logs and user data are never replaced or uploaded. Existing .env stays unchanged. Add UPDATE_ENABLED=false to disable updates. Because the planned repository is private, set GH_UPDATE_TOKEN in your local .env to a fine-grained GitHub token restricted to freegames, Contents read-only. Never upload or paste this token. Without it, update checks fail and your existing bot still starts. No private repository credentials are embedded in the source.

A single-launcher PID guard prevents duplicate launchers; do not also run bot.mjs manually. Source updates are trusted code from this repository, so protect write access. Program backups are kept in .update-backups; restore a backup with the launcher stopped, then run npm ci. No hot reload during command handling: a restart can interrupt active commands/browser sessions; profiles/history remain on disk. Initial install uses npm install; updater installs use npm ci --ignore-scripts. Actual private GitHub download and process restart still require live verification.


## Public release updater (2.8.1)
Run Start-Bot.bat or npm start. The launcher checks public GitHub releases on startup and every 30 minutes, verifies SHA-256 checksums, backs up code, installs it and restarts the bot. No GitHub token is required. `.env`, `state.json`, `stat.json` and other local files are excluded from updates. Set UPDATE_ENABLED=false in .env to disable updates. New installs must download the latest release code to get this updater. Releases publish after tests pass on main; bump package.json and package-lock.json for each release.
