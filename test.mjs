import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteam, parseDeals, qualifyReviews, withoutPlayStation, claimRows, steamRows, giveawayEmbed, Sources, commandDefinitions, parseState, paidGiveaway, offerCard, offerMatches, deadline, settingsCard, notificationPanel, themedOffer, subscriptionCard, normalizeStores, weekendOffer, offerKey, deliveryWindow, cleanConfig, steamGiveaway, epicGiveaways, gogGiveaways } from './bot.mjs';
const row = '<a class="search_result_row" data-ds-appid="10"><span class="title">Game</span><div class="discount_pct">-50%</div><div class="discount_original_price">$20.00</div><div class="discount_final_price">$10.00</div></a>';
test('free rows exclude paid promotions and bundles', () => {
  const html = row + '<a class="search_result_row" data-ds-appid="570" data-price-final="0"><span class="title">Dota 2</span></a><a class="search_result_row" data-ds-appid="10,20" data-price-final="0"><span class="title">Bundle</span></a>';
  assert.deepEqual(parseSteam({results_html:html}).map(g=>g.id), ['570']);
});
test('sale parsing deduplicates and honors thresholds', () => {
  assert.equal(parseDeals({results_html:row+row},30).length,1);
  assert.equal(parseDeals({results_html:row},60).length,0);
  assert.equal(parseDeals({results_html:row},30)[0].price,'$10.00');
});
test('review thresholds, invalid and absent data', () => {
  const data={success:1,query_summary:{total_reviews:100,total_positive:80}};
  assert.equal(qualifyReviews({},data,80,100).positive,80);
  assert.equal(qualifyReviews({},data,81,100),null);
  assert.equal(qualifyReviews({},data,80,101),null);
  assert.throws(()=>qualifyReviews({},{}));
});
test('PlayStation excluded even from cross-platform offers', () => {
  assert.equal(withoutPlayStation({platforms:'Steam, PlayStation 5'}),false);
  assert.equal(withoutPlayStation({platforms:'PC, Xbox One'}),true);
});
test('store claim destinations and lookalike domains', () => {
  for(const [url,label] of [['https://store.steampowered.com/app/570/','Claim on Steam'],['https://store.epicgames.com/en-US/p/game','Claim on Epic'],['https://www.gog.com/en/game/game','Claim on GOG'],['https://gog.com.evil.example/game','Open claim page']]) {
    const button=claimRows({open_giveaway_url:url})[0].toJSON().components[0];
    assert.equal(button.label,label); assert.equal(button.url,url);
  }
  assert.deepEqual(claimRows({open_giveaway_url:'javascript:bad'}),[]);
});
test('buttons and embed limits', () => {
  const games=Array.from({length:50},()=>({title:'x'.repeat(200),url:'https://store.steampowered.com/app/570/'}));
  const rows=steamRows(games).map(r=>r.toJSON());
  assert.equal(rows.length,3); assert.equal(rows.flatMap(r=>r.components).length,15);
  assert.ok(rows.flatMap(r=>r.components).every(b=>b.label.length<=80));
  const e=giveawayEmbed({title:'x'.repeat(400),description:'d'.repeat(5000),instructions:'i'.repeat(3000),open_giveaway_url:'https://www.gamerpower.com/test'}).toJSON();
  assert.equal(e.title.length,256); assert.match(e.fields.at(-1).value,/GamerPower/);
});
test('giveaway filters, cache, source errors and no results', async () => {
  const calls=[];
  const source=new Sources(async url=>{calls.push(url);return {ok:true,status:200,json:async()=>[{status:'Active',type:'Game',worth:'$19.99',platforms:'Steam'},{status:'Active',platforms:'PS5'},{status:'Expired',platforms:'GOG'}]};});
  source.steamFree=async()=>[];source.epicFree=async()=>[];source.gogFree=async()=>[];
  for(const store of ['itchio','drm-free']) {
    assert.equal((await source.giveaways(store)).length,1);
    assert.equal(calls.at(-1).searchParams.get('platform'),store==='all'?null:store);
  }
  await source.giveaways('drm-free'); assert.equal(calls.length,2);
  await assert.rejects(source.giveaways('ps5'));
  const empty=new Sources(async()=>({status:201})); assert.deepEqual(await empty.giveaways('itchio'),[]);
  const failure=new Sources(async()=>({ok:false,status:403})); await assert.rejects(failure.giveaways('itchio'));
});
test('deal review checks integrate with search and filters', async () => {
  const source=new Sources(async url=>({status:200,ok:true,json:async()=>url.pathname.includes('appreviews')?{success:1,query_summary:{total_reviews:200,total_positive:180}}:{results_html:row,total_count:1}}));
  const result=await source.deals(1,'',30,80,100);
  assert.equal(result.games.length,1); assert.equal(result.games[0].positive,90); assert.equal(result.failures,0);
});
test('slash command schemas preserve commands and exclude PlayStation', () => {
  const commands=commandDefinitions();
  assert.deepEqual(commands.map(c=>c.name),['free','deals','giveaways','alerts','stopalerts','settings','preferences','wishlist','claimed','configure','notificationsettings','health','updates','schedule','exportsettings','importsettings','prime','gamepass','stores']);
  const alerts=commands.find(c=>c.name==='alerts');
  assert.equal(alerts.options[0].required,true);
  assert.ok(alerts.options.find(o=>o.name==='store').choices.every(c=>!c.value.startsWith('ps')));
});

test('Python state migration preserves exact Discord snowflakes', () => {
  const state=parseState('{"channels":{"123":{"channel":1234567890123456789,"seen":["42"]}}}');
  assert.equal(state.channels['123'].channel,'1234567890123456789');
  assert.deepEqual(state.channels['123'].seen,['42']);
});

test('only reported normally paid giveaways qualify', () => {
  const base = {status:'Active',type:'Game',platforms:'Steam',worth:'$19.99',end_date:'N/A'};
  assert.equal(paidGiveaway(base),true);
  for(const worth of ['N/A','$0.00','Free','']) assert.equal(paidGiveaway({...base,worth}),false);
  assert.equal(paidGiveaway({...base,type:'Loot'}),false);
  assert.equal(paidGiveaway({...base,status:'Expired'}),false);
  assert.equal(paidGiveaway({...base,end_date:'2020-01-01 12:00:00'}),false);
  assert.equal(paidGiveaway({...base,platforms:'PS5'}),false);
});

test('offer card has image, store/type menus and navigation', () => {
  const games=[{title:'Test',type:'Game',worth:'$10.00',platforms:'Epic Games Store',image:'https://example.com/image.png',open_giveaway_url:'https://store.epicgames.com/en-US/p/test'}];
  const session={store:'all',kind:'game',index:100};
  const card=offerCard(games,session,'test-id');
  assert.equal(session.index,0);
  assert.equal(card.embeds[0].toJSON().image.url,games[0].image);
  const rows=card.components.map(r=>r.toJSON());
  assert.equal(rows.length,4);
  assert.equal(rows[1].components[0].custom_id,'browse:test-id:store');
  assert.equal(rows[2].components[0].options[1].value,'loot');
  assert.ok(rows[3].components.slice(0,2).every(b=>b.disabled));
  assert.equal(rows[3].components[2].label,'Mark claimed');
  assert.equal(offerCard([],session,'empty').components.length,3);
});
test('DLC filter is separate from full games and excludes PS', async () => {
  const calls=[];
  const source=new Sources(async url=>{calls.push(url);return {ok:true,status:200,json:async()=>[
    {status:'Active',type:'DLC & Loot',platforms:'Steam',worth:'N/A'},
    {status:'Active',type:'DLC & Loot',platforms:'PS5'},
    {status:'Active',type:'Game',platforms:'Steam',worth:'$10.00'}]};});
  source.steamFree=async()=>[];source.epicFree=async()=>[];source.gogFree=async()=>[];
  assert.equal((await source.giveaways('all','loot')).length,1);
  assert.equal(calls[0].searchParams.get('type'),'loot');
  assert.equal((await source.giveaways('all','game')).length,0);
  assert.equal(calls.length,2);
});

test('preferences combine store and genre/keyword filters',()=>{
  const game={title:'Survival',description:'Co-op adventure',platforms:'PC, Epic Games Store'};
  assert.equal(offerMatches(game,{stores:['epic-games-store'],keywords:['co-op']}),true);
  assert.equal(offerMatches(game,{stores:['gog']}),false);
  assert.equal(offerMatches(game,{stores:['all'],keywords:['racing']}),false);
});
test('expiry reminder dates are explicit UTC assumptions',()=>{
  assert.equal(deadline({end_date:'2026-10-15 12:00:00'}),Date.parse('2026-10-15T12:00:00Z'));
  assert.equal(deadline({end_date:'N/A'}),null);
});
test('settings panel encodes owner and current settings',()=>{
  const payload=settingsCard({stores:['gog'],wishlistDM:true},'123');
  const rows=payload.components.map(r=>r.toJSON());
  assert.equal(rows[0].components[0].custom_id,'settings:123:stores');
  assert.equal(rows[0].components[0].options.find(o=>o.value==='gog').default,true);
  assert.equal(rows[2].components[1].label,'Disable wishlist DMs');
});

test('account commands enable private/group DM contexts; admin commands stay server-only',()=>{
  const commands=commandDefinitions();
  for(const name of ['free','deals','giveaways','stores','settings','preferences','wishlist','claimed']) {
    const command=commands.find(c=>c.name===name);
    assert.deepEqual(command.integration_types,[0,1]);
    assert.deepEqual(command.contexts,[0,1,2]);
    assert.equal(command.dm_permission,undefined);
  }
  for(const name of ['alerts','configure','stopalerts','notificationsettings','schedule','exportsettings','importsettings']) {
    const command=commands.find(c=>c.name===name);
    assert.deepEqual(command.integration_types,[0]);
    assert.deepEqual(command.contexts,[0]);
  }
});

test('notification panels fit Discord component limits',()=>{
  for(const tab of ['home','filters','display','notifications','more']) {
    const card=notificationPanel({channel:'123'},'456','game',tab);
    assert.ok(card.components.length<=5);
    for(const row of card.components)assert.ok(row.toJSON().components.length<=5);
  }
});
test('display themes omit images or embeds as selected',()=>{
  const game={title:'Test',type:'Game',worth:'$10.00',image:'https://example.com/image.png',open_giveaway_url:'https://www.gog.com/',description:'Description',end_date:'N/A'};
  assert.equal(themedOffer(game,{theme:'noimages'}).embeds[0].toJSON().image,undefined);
  assert.deepEqual(themedOffer(game,{theme:'link'}).embeds,[]);
  assert.equal(themedOffer(game,{theme:'link'}).content,game.open_giveaway_url);
  assert.equal(themedOffer(game,{links:false}).components.length,0);
});

test('Steam direct verification requires normally paid game and 100% off',()=>{
  const data={10:{success:true,data:{name:'Paid Game',type:'game',price_overview:{initial:1999,final:0,discount_percent:100,currency:'USD',initial_formatted:'$19.99'}}}};
  assert.equal(steamGiveaway('10',data).source,'Steam');
  assert.equal(steamGiveaway('10',data).open_giveaway_url,'https://store.steampowered.com/app/10/');
  data[10].data.price_overview.initial=0;assert.equal(steamGiveaway('10',data),null);
  data[10].data.price_overview.initial=1999;data[10].data.price_overview.final=999;assert.equal(steamGiveaway('10',data),null);
});

test('direct Epic excludes upcoming and permanent free products',()=>{
 const element={id:'1',title:'Game',productSlug:'game',price:{totalPrice:{originalPrice:1999,discountPrice:0,currencyCode:'USD'}},promotions:{promotionalOffers:[{promotionalOffers:[{startDate:'2026-10-01T00:00:00Z',endDate:'2026-10-31T00:00:00Z',discountSetting:{discountPercentage:0}}]}]}};
 const data={data:{Catalog:{searchStore:{elements:[element]}}}};
 assert.equal(epicGiveaways(data,Date.parse('2026-10-13T00:00:00Z')).length,1);
 assert.equal(epicGiveaways(data,Date.parse('2026-11-01T00:00:00Z')).length,0);
 element.price.totalPrice.originalPrice=0;assert.equal(epicGiveaways(data).length,0);
});
test('GOG rejects permanently free and paid catalog rows',()=>{
 const product={id:'1',title:'Game',url:'/en/game/game',price:{basePrice:'19.99',finalPrice:'0.00',currency:'USD'}};
 assert.equal(gogGiveaways({products:[product]})[0].source,'GOG');
 product.price.basePrice='0.00';assert.equal(gogGiveaways({products:[product]}).length,0);
});

test('subscription cards disclose membership and link to official sources',()=>{
 for(const service of ['prime','gamepass']) {
  const card=subscriptionCard(service);
  assert.match(card.embeds[0].toJSON().fields[0].value,/membership benefits/);
  assert.match(card.components[0].toJSON().components[0].url,/luna.amazon.com|xbox.com/);
 }
});

test('server store selection supports multiple choices and all override',async()=>{
 assert.deepEqual(normalizeStores(['steam','gog','steam']),['steam','gog']);
 assert.deepEqual(normalizeStores(['steam','all']),['all']);
 const card=notificationPanel({channel:'1',platforms:['steam','gog']},'2','game','filters');
 const menu=card.components[0].toJSON().components[0];
 assert.ok(menu.max_values>1);
 assert.deepEqual(menu.options.filter(o=>o.default).map(o=>o.value),['steam','gog']);
 const source=new Sources();const calls=[];
 source.giveaways=async store=>{calls.push(store);return [{id:'same'},{id:store}];};
 const games=await source.selectedGiveaways(['steam','gog']);
 assert.deepEqual(calls,['steam','gog']);assert.equal(games.length,3);
});

test('free weekend requires live purchase-block promotion, not description text',()=>{
 const details={10:{success:true,data:{name:'Game',type:'game',price_overview:{initial:1999}}}};
 assert.equal(weekendOffer('10',details,'<div class="game_area_purchase_game">Play for free! Ends in 2 days</div>').type,'Free Weekend');
 assert.equal(weekendOffer('10',details,'<p>We held a free weekend last year</p>'),null);
 assert.equal(weekendOffer('10',details,'<div class="game_area_purchase_game">Buy now</div>'),null);
});

test('updater excludes local secrets/state and rejects corrupt blobs',async()=>{
 const {UPDATE_FILES,verifyBlob}=await import('./updater.mjs');
 const {createHash}=await import('node:crypto');
 for(const file of ['.env','state.json','stat.json','bot.log'])assert.ok(!UPDATE_FILES.includes(file));
 const bytes=Buffer.from('source');const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 assert.doesNotThrow(()=>verifyBlob(bytes,sha));
 assert.throws(()=>verifyBlob(Buffer.from('corrupt'),sha));
});

test('partial recovery returns healthy stores and records failed source',async()=>{
 const source=new Sources();
 const result=await source.combine([['Steam',async()=>[{id:'one'}]],['Epic',async()=>{throw new Error('offline');}],['GOG',async()=>[{id:'two'}]]]);
 assert.deepEqual(result.map(g=>g.id),['one','two']);
 assert.equal(source.health.get('Epic').ok,false);
 assert.equal(source.health.get('Steam').count,1);
 await assert.rejects(source.combine([['Steam',async()=>{throw new Error('offline');}]]),/All selected/);
});
test('failed cached source is recorded and not cached as an empty success',async()=>{
 const source=new Sources();
 await assert.rejects(source.cached('test-source',300000,async()=>{throw new Error('offline');}));
 assert.equal(source.cache.has('test-source'),false);
 assert.equal(source.health.get('test-source').ok,false);
});

test('cross-feed identity ignores tracking parameters but separates offer types',()=>{
 const a={id:'feed:1',type:'Game',open_giveaway_url:'https://store.steampowered.com/app/10/?utm_source=a'};
 const b={...a,id:'steam:10',open_giveaway_url:'https://store.steampowered.com/app/10/'};
 assert.equal(offerKey(a),offerKey(b));assert.notEqual(offerKey(a),offerKey({...b,type:'Free Weekend'}));
});
test('quiet hours wrap midnight and digest runs once per local day',()=>{
 const c={timezone:'America/Chicago',quietStart:22,quietEnd:7,digest:true,digestHour:18};
 assert.equal(deliveryWindow(c,new Date('2026-10-14T04:00:00Z')).quiet,true);
 const at6=deliveryWindow(c,new Date('2026-10-13T23:00:00Z'));assert.equal(at6.digestDue,true);
 assert.equal(deliveryWindow({...c,lastDigest:at6.day},new Date('2026-10-13T23:00:00Z')).digestDue,false);
 assert.equal(deliveryWindow({...c,quietEnd:22},new Date('2026-10-14T04:00:00Z')).quiet,false);
});
test('settings export excludes runtime history and local secrets',()=>{
 const c=cleanConfig({channel:'1',theme:'info',timezone:'America/Chicago',seen:['a'],posts:{},DISCORD_TOKEN:'secret'});
 assert.equal(c.seen,undefined);assert.equal(c.DISCORD_TOKEN,undefined);assert.equal(c.channel,'1');
 assert.throws(()=>cleanConfig({quietStart:99}));
});
test('expired offers remove claim links and label cards',()=>{
 const game={title:'Ended',type:'Game',worth:'$10.00',end_date:'2020-01-01T00:00:00Z',open_giveaway_url:'https://www.gog.com/en/game/test'};
 assert.equal(claimRows(game).length,0);assert.match(giveawayEmbed(game).toJSON().title,/EXPIRED/);
});
