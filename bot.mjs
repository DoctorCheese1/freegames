import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  MessageFlags, escapeMarkdown } from 'discord.js';
import { load } from 'cheerio';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(ROOT, '.env'), quiet: true });
export const PLATFORMS = {
  all: 'All platforms', steam: 'Steam', 'epic-games-store': 'Epic Games Store', gog: 'GOG',
  itchio: 'itch.io', 'drm-free': 'DRM-free', pc: 'PC (other stores too)',
  'xbox-one': 'Xbox One', 'xbox-series-xs': 'Xbox Series X/S', switch: 'Nintendo Switch',
  android: 'Android', ios: 'iOS',
};
const choices = Object.entries(PLATFORMS).map(([value, name]) => ({ name, value }));
export const withoutPlayStation = game => !/playstation|ps4|ps5|ps vita/i.test(String(game.platforms ?? ''));
export function paidGiveaway(game, now = Date.now()) {
  // A positive source-reported retail value is required; unknown values are omitted.
  const worth = String(game.worth ?? '').trim();
  const value = /^\$?\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(worth)
    ? Number(worth.replace(/[$,]/g, '')) : 0;
  const end = String(game.end_date ?? '').trim();
  if (end && end !== 'N/A' && end !== 'Unknown') {
    // Source dates have no timezone; only reject offers expired on an earlier UTC date.
    const date = end.slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < new Date(now).toISOString().slice(0,10)) return false;
  }
  return game.status === 'Active' && game.type === 'Game' && value > 0 && withoutPlayStation(game);
}
const text = (value, limit) => String(value ?? '').slice(0, limit);
const storeUrl = id => `https://store.steampowered.com/app/${id}/`;
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(join(ROOT, 'bot.log'), line + '\n');
}

export function parseSteam(payload) {
  const $ = load(payload.results_html ?? '');
  const games = [], seen = new Set();
  $('a.search_result_row').each((_, element) => {
    const row = $(element), id = row.attr('data-ds-appid') ?? '';
    const title = row.find('.title').text().trim();
    const price = row.find('.discount_final_price, .search_price').first().text().trim().toLowerCase();
    if (/^\d+$/.test(id) && title && !seen.has(id) && (row.attr('data-price-final') === '0' || ['free', 'free to play'].includes(price))) {
      seen.add(id); games.push({ id, title, url: storeUrl(id) });
    }
  });
  return games;
}
export function parseDeals(payload, minDiscount = 30) {
  const $ = load(payload.results_html ?? '');
  const games = [], seen = new Set();
  $('a.search_result_row').each((_, element) => {
    const row = $(element), id = row.attr('data-ds-appid') ?? '';
    const title = row.find('.title').text().trim();
    const match = row.find('.discount_pct, .search_discount span').first().text().match(/(\d+)%/);
    const price = row.find('.discount_final_price').text().trim();
    if (!/^\d+$/.test(id) || !title || !match || !price || seen.has(id) || Number(match[1]) < minDiscount) return;
    seen.add(id);
    games.push({ id, title, url: storeUrl(id), discount: Number(match[1]), price,
      original: row.find('.discount_original_price').text().trim() || 'Not reported' });
  });
  return games;
}
export function steamGiveaway(id,payload) {
  const entry=payload?.[id],d=entry?.data,p=d?.price_overview;
  if(!entry?.success || d?.type!=='game' || !p || p.initial<=0 || p.final!==0 || p.discount_percent!==100)return null;
  return {id:`steam:${id}`,title:d.name,type:'Game',status:'Active',worth:p.initial_formatted || `${p.currency} ${(p.initial/100).toFixed(2)}`,
    description:d.short_description || '',platforms:'PC, Steam',image:d.header_image,end_date:'Unknown — check Steam',
    open_giveaway_url:storeUrl(id),instructions:'Open the Steam store page and add the game to your account while the 100% discount is active.',source:'Steam',regular_value:p.initial/100};
}
export function weekendOffer(id,details,html) {
  const d=details?.[id]?.data;
  if(!details?.[id]?.success || d?.type!=='game' || !(d.price_overview?.initial>0))return null;
  const $=load(html);
  const blocks=$('.game_area_purchase_game, .game_area_purchase_game_wrapper').toArray().map(e=>$(e).text().replace(/\s+/g,' ').trim());
  const promotion=blocks.find(t=>/play for free[!\s].*ends|free (?:weekend|play period)|free to play until/i.test(t));
  if(!promotion)return null;
  return {id:`weekend:steam:${id}`,title:d.name,type:'Free Weekend',status:'Active',source:'Steam',platforms:'PC, Steam',
    description:d.short_description || '',image:d.header_image,worth:d.price_overview.initial_formatted || 'Normally paid',
    regular_value:d.price_overview.initial/100,end_date:'See Steam for the exact play-period deadline',
    open_giveaway_url:storeUrl(id),instructions:`Temporary access only — you do not keep the game. ${text(promotion,600)}`};
}
export function epicGiveaways(payload,now=Date.now()) {
  const entries=payload?.data?.Catalog?.searchStore?.elements;
  if(!Array.isArray(entries))throw new Error('Epic promotions response changed');
  return entries.flatMap(g=>{
    const price=g.price?.totalPrice;
    const promo=g.promotions?.promotionalOffers?.flatMap(p=>p.promotionalOffers || []).find(p=>Date.parse(p.startDate)<=now && Date.parse(p.endDate)>now && p.discountSetting?.discountPercentage===0);
    if(!promo || !price || price.originalPrice<=0 || price.discountPrice!==0 || g.offerType==='DLC')return [];
    const slug=g.catalogNs?.mappings?.find(m=>m.pageType==='productHome')?.pageSlug || g.productSlug || g.urlSlug;
    if(!slug || slug.includes('mystery'))return [];
    return [{id:`epic:${g.id}`,title:g.title,type:'Game',status:'Active',platforms:'PC, Epic Games Store',source:'Epic Games Store',
      regular_value:price.originalPrice/100,worth:price.fmtPrice?.originalPrice || `${price.currencyCode} ${(price.originalPrice/100).toFixed(2)}`,
      image:g.keyImages?.find(i=>i.type==='OfferImageWide')?.url || g.keyImages?.[0]?.url,
      description:g.description || '',end_date:promo.endDate,open_giveaway_url:`https://store.epicgames.com/en-US/p/${slug}`,
      instructions:'Open the Epic store and claim this game before the free promotion ends.'}];
  });
}
export function gogGiveaways(payload) {
  if(!Array.isArray(payload?.products))throw new Error('GOG catalog response changed');
  return payload.products.flatMap(g=>{
    const p=g.price,base=Number(p?.basePrice),final=Number(p?.finalPrice);
    if(!p || !Number.isFinite(base) || base<=0 || final!==0 || !g.url)return [];
    const url=new URL(g.url,'https://www.gog.com').href;
    if(new URL(url).hostname!=='www.gog.com')return [];
    return [{id:`gog:${g.id}`,title:g.title,type:'Game',status:'Active',platforms:'PC, GOG',source:'GOG',regular_value:base,
      worth:`${p.currency || 'USD'} ${base.toFixed(2)}`,description:'Normally paid game currently listed at zero price in the GOG catalog.',
      image:typeof g.coverHorizontal==='string'?g.coverHorizontal:undefined,end_date:'Unknown — check GOG',open_giveaway_url:url,
      instructions:'Open the GOG store page and verify the offer before adding it to your account.'}];
  });
}
export function qualifyReviews(game, payload, minPositive = 80, minReviews = 100) {
  if (payload?.success !== 1 || !payload.query_summary) throw new Error('Steam reviews response changed');
  const total = Number(payload.query_summary.total_reviews ?? 0);
  const positive = Number(payload.query_summary.total_positive ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(positive) || total < 0 || positive < 0 || positive > total) throw new Error('Invalid review counts');
  const score = total ? positive * 100 / total : 0;
  return total >= minReviews && score >= minPositive ? { ...game, positive: score, reviews: total } : null;
}
export function claimRows(game) {
  const end=deadline(game);if(end && end<=Date.now())return [];
  let url;
  try { url = new URL(game.open_giveaway_url); } catch { return []; }
  if (url.protocol !== 'https:') return [];
  const store = [['store.steampowered.com', 'Steam'], ['epicgames.com', 'Epic'], ['gog.com', 'GOG'], ['itch.io', 'itch.io']]
    .find(([domain]) => url.hostname === domain || url.hostname.endsWith('.' + domain));
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel(store ? `Claim on ${store[1]}` : 'Open claim page').setURL(url.href))];
}
export function steamRows(games, count = 15) {
  const rows = [];
  games.slice(0, count).forEach((g, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder());
    rows.at(-1).addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(text('Open ' + g.title, 80)).setURL(g.url));
  });
  return rows;
}
export function giveawayEmbed(game) {
  const embed = new EmbedBuilder().setTitle(text(game.title, 256) || 'Free game')
    .setDescription(text(game.description, 1800) || 'Open the claim page for details.').setColor(0x57F287)
    .addFields(
      { name: 'Platforms', value: text(game.platforms, 200) || 'See claim page' },
      { name: 'Offer', value: game.type==='Free Weekend'?'Free Weekend • temporary access, not yours to keep':game.type === 'Game' ? `100% discount • ${text(game.worth, 100)} → Free` : 'DLCs & More • Free offer' },
      { name: 'Claim instructions', value: text(game.instructions, 1000) || 'Open the claim page.' },
      { name: 'Ends (reported by source)', value: text(game.end_date, 100) || 'Unknown' },
      { name: 'Source', value: game.source==='Steam'?'[Steam Store](https://store.steampowered.com)':game.source==='Epic Games Store'?'[Epic Games Store](https://store.epicgames.com)':game.source==='GOG'?'[GOG](https://www.gog.com)':'[GamerPower](https://www.gamerpower.com)' })
    .setFooter({ text: game.source==='Steam'?'Price verified from Steam; check availability and deadline on the store.':'Check region, key stock, and claim terms; free weekends may apply.' });
  const ends=deadline(game);
  if(ends && ends<=Date.now()){embed.setTitle(text('EXPIRED • '+game.title,256));embed.addFields({name:'Offer status',value:'Expired — claim availability ended.'});}
  else if(ends && ends-Date.now()<=24*3600000)embed.addFields({name:'Leaving soon',value:`Ends <t:${Math.floor(ends/1000)}:R>`});
  if (claimRows(game).length) embed.setURL(game.open_giveaway_url);
  if (/^https:\/\//.test(game.image ?? '')) embed.setImage(game.image);
  return embed;
}

export class Sources {
  constructor(request = fetch, options={}) { this.request=request;this.cache=new Map();this.inflight=new Map();this.health=new Map();this.retryTimers=new Map();this.retryAttempts=new Map();this.autoRetry=options.autoRetry!==false;this.retryDelayMs=options.retryDelayMs; }
  async json(address, params = {}, signal) {
    const url = new URL(address);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(40000);
      const response = await this.request(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'User-Agent': 'FreeGamesDiscordBot/2.0' } });
      if (response.status === 201) return [];
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel(); await delay(2000 * 2 ** attempt, undefined, { signal }); continue;
      }
      if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
      return response.json();
    }
    throw new Error('Source unavailable');
  }
  async cached(key, lifetime, producer) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < lifetime) return cached.data;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = producer().then(data => { this.cache.set(key, { time: Date.now(), data }); const old=this.health.get(key);this.health.set(key,{ok:true,time:Date.now(),count:Array.isArray(data)?data.length:null,recoveredAt:old?.ok===false?Date.now():old?.recoveredAt});if(old?.ok===false)log(`Offer source recovered: ${key}`);clearTimeout(this.retryTimers.get(key));this.retryTimers.delete(key);this.retryAttempts.delete(key);return data; }).catch(error=>{this.health.set(key,{ok:false,time:Date.now(),error:error.message});this.scheduleRetry(key,lifetime,producer);throw error;});
    this.inflight.set(key, pending);
    try { return await pending; } finally { this.inflight.delete(key); }
  }
  async combine(entries) {
    const results=await Promise.allSettled(entries.map(([,producer])=>producer()));
    let successes=0;const games=[];
    results.forEach((result,index)=>{
      const name=entries[index][0];
      if(result.status==='fulfilled'){successes++;games.push(...result.value);this.health.set(name,{ok:true,time:Date.now(),count:result.value.length});}
      else this.health.set(name,{ok:false,time:Date.now(),error:String(result.reason.message || result.reason)});
    });
    if(!successes)throw new Error('All selected offer sources unavailable. Use /health for details.');
    return [...new Map(games.map(g=>[offerKey(g),g])).values()];
  }
  scheduleRetry(key,lifetime,producer) {
    if(!this.autoRetry || this.retryTimers.has(key) || !/^(steam-direct-free|epic-direct-free|gog-direct-free|steam-weekends|giveaways:)/.test(key))return;
    const attempts=this.retryAttempts.get(key) || 0;
    if(attempts>=5)return;
    const wait=this.retryDelayMs ?? [60000,120000,300000,600000,900000][attempts];
    this.retryAttempts.set(key,attempts+1);
    const health=this.health.get(key) || {};this.health.set(key,{...health,nextRetry:Date.now()+wait,retryAttempt:attempts+1});
    const timer=setTimeout(()=>{this.retryTimers.delete(key);void this.cached(key,lifetime,producer).catch(()=>{});},wait);
    timer.unref?.();this.retryTimers.set(key,timer);
  }
  close(){for(const timer of this.retryTimers.values())clearTimeout(timer);this.retryTimers.clear();}
  async giveaways(platform = 'all', kind = 'game') {
    if (!Object.hasOwn(PLATFORMS, platform)) throw new Error('Unknown platform');
    if (!['game', 'loot', 'weekend'].includes(kind)) throw new Error('Unknown offer type');
    return this.cached(`giveaways:${platform}:${kind}`, 300000, async () => {
      if(kind==='weekend')return ['all','steam','pc'].includes(platform)?this.freeWeekends():[];
      if(platform==='steam' && kind==='game')return this.steamFree();
      if(platform==='epic-games-store' && kind==='game')return this.epicFree();
      if(platform==='gog' && kind==='game')return this.gogFree();
      if(platform==='all' && kind==='game')return this.combine([['Steam',()=>this.steamFree()],['Epic',()=>this.epicFree()],['GOG',()=>this.gogFree()],['GamerPower',()=>this.feedOtherGames()]]);
      const params = { type: kind, 'sort-by': 'date' };
      if (platform !== 'all') params.platform = platform;
      const data = await this.json('https://www.gamerpower.com/api/giveaways', params);
      if (!Array.isArray(data)) throw new Error('Giveaway response changed');
      const games=data.filter(g => kind === 'game' ? paidGiveaway(g) : g.status === 'Active' && ['DLC & Loot', 'Loot'].includes(g.type) && withoutPlayStation(g));

      return games;
    });
  }
  async selectedGiveaways(stores,kind='game') {
    const selected=normalizeStores(stores);
    if(selected.includes('all'))return this.giveaways('all',kind);
    return this.combine(selected.map(store=>[PLATFORMS[store],()=>this.giveaways(store,kind)]));
  }
  async feedOtherGames() {
    const data=await this.json('https://www.gamerpower.com/api/giveaways',{type:'game','sort-by':'date'});
    if(!Array.isArray(data))throw new Error('Giveaway response changed');
    return data.filter(g=>paidGiveaway(g) && !/steam|epic|gog/i.test(String(g.platforms)));
  }
  async freeWeekends() {
    return this.cached('steam-weekends',300000,async()=>{
      const country=process.env.STEAM_COUNTRY || 'US';
      const featured=await this.json('https://store.steampowered.com/api/featuredcategories',{cc:country,l:'english'});
      const ids=new Set();
      for(const section of Object.values(featured))for(const item of section?.items || [])if(item.id)ids.add(String(item.id));
      const search=await this.search(1,'',true),$=load(search.results_html);
      $('a.search_result_row').each((_,el)=>{const id=$(el).attr('data-ds-appid');if(/^\d+$/.test(id || ''))ids.add(id);});
      const candidates=[...ids].slice(0,100),games=[];let next=0,failures=0;
      const signal=AbortSignal.timeout(120000);
      await Promise.all(Array.from({length:3},async()=>{
        while(next<candidates.length){const id=candidates[next++];try {
          const details=await this.json('https://store.steampowered.com/api/appdetails',{appids:id,cc:country,l:'english'},signal);
          if(details?.[id]?.data?.type!=='game' || !(details[id].data.price_overview?.initial>0))continue;
          const response=await this.request(`${storeUrl(id)}?cc=${country}&l=english`,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
          if(!response.ok)throw new Error('Steam page unavailable');
          const game=weekendOffer(id,details,await response.text());if(game)games.push(game);
        }catch{failures++;}}
      }));
      if(failures)log(`Free-weekend scan: ${failures} candidates unavailable; coverage may be incomplete.`);
      return games;
    });
  }
  async epicFree() {
    return this.cached('epic-direct-free',300000,async()=>epicGiveaways(await this.json('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions',{locale:'en-US',country:process.env.STEAM_COUNTRY || 'US',allowCountries:process.env.STEAM_COUNTRY || 'US'})));
  }
  async gogFree() {
    return this.cached('gog-direct-free',300000,async()=>{
      const games=[];
      for(let page=1;page<=10;page++) {
        const data=await this.json('https://catalog.gog.com/v1/catalog',{limit:48,page,order:'desc:trending',productType:'in:game',price:'between:0,0',countryCode:process.env.STEAM_COUNTRY || 'US',currencyCode:'USD'});
        games.push(...gogGiveaways(data));
        if(page>=Number(data.pages || data.pagination?.pages || 1))break;
      }
      return games;
    });
  }
  async steamFree() {
    return this.cached('steam-direct-free',300000,async()=>{
      const ids=new Set();
      for(let page=0;page<10;page++) {
        const data=await this.json('https://store.steampowered.com/search/results/',{
          start:page*100,count:100,specials:1,maxprice:'free',category1:998,hidef2p:1,
          cc:process.env.STEAM_COUNTRY || 'US',l:'english',infinite:1,json:1,ignore_preferences:1});
        if(typeof data?.results_html!=='string')throw new Error('Steam free search response changed');
        for(const g of parseDeals(data,100))if(g.discount===100)ids.add(g.id);
        if((page+1)*100>=Number(data.total_count || 0))break;
      }
      const list=[...ids],games=[];let next=0,failed=0;
      const signal=AbortSignal.timeout(120000);
      await Promise.all(Array.from({length:3},async()=>{
        while(next<list.length) {
          const id=list[next++];
          try {const data=await this.json('https://store.steampowered.com/api/appdetails',{appids:id,cc:process.env.STEAM_COUNTRY || 'US',l:'english'},signal);const game=steamGiveaway(id,data);if(game)games.push(game);}
          catch {failed++;}
        }
      }));
      if(failed)throw new Error(`Steam price verification unavailable for ${failed} candidates; retry shortly.`);
      return games;
    });
  }
  async search(page, search, deals = false) {
    const params = { start: (page - 1) * (deals ? 20 : 50), count: deals ? 20 : 50, category1: '998',
      sort_by: '_ASC', cc: process.env.STEAM_COUNTRY || 'US', l: 'english', term: text(search, 100),
      infinite: '1', json: '1', ignore_preferences: '1' };
    if (deals) params.specials = '1'; else { params.maxprice = 'free'; params.supportedlang = 'english'; }
    const data = await this.json('https://store.steampowered.com/search/results/', params);
    if (!data || typeof data.results_html !== 'string') throw new Error('Steam search response changed');
    return data;
  }
  async deals(page, search, minDiscount, minPositive, minReviews) {
    const data = await this.search(page, search, true), candidates = parseDeals(data, minDiscount).slice(0, 20);
    const games = []; let next = 0, failures = 0;
    const signal = AbortSignal.timeout(120000);
    const worker = async () => {
      while (next < candidates.length) {
        const game = candidates[next++];
        try {
          const reviews = await this.cached(`reviews:${game.id}`, 3600000, async () => {
            const result = await this.json(`https://store.steampowered.com/appreviews/${game.id}`,
              { json: '1', language: 'all', filter: 'all', purchase_type: 'all', num_per_page: '1' }, signal);
            qualifyReviews(game, result, 0, 0); return result;
          });
          const qualified = qualifyReviews(game, reviews, minPositive, minReviews);
          if (qualified) games.push(qualified);
        } catch { failures++; }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    games.sort((a,b) => b.discount - a.discount || b.positive - a.positive || b.reviews - a.reviews);
    return { games, total: Number(data.total_count ?? 0), failures };
  }
}

const integer = (cmd, name, description, max) => cmd.addIntegerOption(o => o.setName(name).setDescription(description).setMinValue(1).setMaxValue(max));
const storeOption = cmd => cmd.addStringOption(o => o.setName('store').setDescription('Store/platform; default all').addChoices(...choices));
const searchOption = cmd => cmd.addStringOption(o => o.setName('search').setDescription('Optional game name').setMaxLength(100));
export function commandDefinitions() {
  const free = searchOption(integer(storeOption(new SlashCommandBuilder().setName('free').setDescription('Browse free offers with game cards and store filters')), 'page', 'Offer number', 10000));
  const deals = searchOption(integer(new SlashCommandBuilder().setName('deals').setDescription('Discounted Steam games with strong player reviews'), 'page', 'Page number (20 sale candidates)', 10000));
  integer(deals, 'min_discount', 'Minimum discount percent; default 30', 100);
  integer(deals, 'min_positive', 'Minimum positive review percent; default 80', 100);
  integer(deals, 'min_reviews', 'Minimum review count; default 100', 1000000);
  const giveaways = integer(storeOption(new SlashCommandBuilder().setName('giveaways').setDescription('Normally paid games offered free across stores')), 'page', 'Offer number', 10000);
  const alerts = new SlashCommandBuilder().setName('alerts').setDescription('Set automatic giveaway alert channel').setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Alert channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true));
  storeOption(alerts);
  const stop = new SlashCommandBuilder().setName('stopalerts').setDescription('Disable automatic giveaway alerts').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const settings = new SlashCommandBuilder().setName('settings').setDescription('Open settings').addStringOption(o=>o.setName('scope').setDescription('Personal preferences or server notifications').addChoices({name:'Personal',value:'personal'},{name:'Server notifications',value:'server'}));
  const preferences = new SlashCommandBuilder().setName('preferences').setDescription('Set genre or keyword preferences')
    .addStringOption(o=>o.setName('keywords').setDescription('Comma separated words, or all to clear').setMaxLength(200).setRequired(true));
  const wishlist = new SlashCommandBuilder().setName('wishlist').setDescription('Manage game name watches')
    .addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'List',value:'list'}))
    .addStringOption(o=>o.setName('name').setDescription('Game title to watch').setMaxLength(100));
  const claimed = new SlashCommandBuilder().setName('claimed').setDescription('View or clear your claimed offer tracking')
    .addStringOption(o=>o.setName('action').setDescription('Action').addChoices({name:'List',value:'list'},{name:'Clear all',value:'clear'}));
  const notificationsettings = new SlashCommandBuilder().setName('notificationsettings').setDescription('Server notification filters, display and test settings').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('type').setDescription('Stream').addChoices({name:'100% Discount',value:'game'},{name:'DLCs & More',value:'loot'},{name:'Steam deals',value:'deals'},{name:'Free Weekend (Steam)',value:'weekend'}));
  const history = new SlashCommandBuilder().setName('history').setDescription('View this server’s notification audit history').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(o=>o.setName('page').setDescription('20 entries per page').setMinValue(1).setMaxValue(15))
    .addStringOption(o=>o.setName('status').setDescription('Filter').addChoices(...['posted','skipped','failed','expired'].map(value=>({name:value,value}))))
    .addBooleanOption(o=>o.setName('export').setDescription('Download retained history as JSON'));
  const diagnostics = new SlashCommandBuilder().setName('diagnostics').setDescription('Test live offer sources and explain failures')
    .addStringOption(o=>o.setName('source').setDescription('Source to test').addChoices(...['all','steam','epic','gog','feed'].map(value=>({name:value,value}))));
  const health = new SlashCommandBuilder().setName('health').setDescription('Show source health from recent checks');
  const updates = new SlashCommandBuilder().setName('updates').setDescription('Update status and owner-only check/rollback')
    .addStringOption(o=>o.setName('action').setDescription('Action').addChoices({name:'Status',value:'status'},{name:'Check now',value:'check'},{name:'Rollback latest update',value:'rollback'}));
  const prime = new SlashCommandBuilder().setName('prime').setDescription('Open official Amazon Prime game claim offers');
  const gamepass = new SlashCommandBuilder().setName('gamepass').setDescription('Open official Xbox Game Pass catalog');
  const configure = new SlashCommandBuilder().setName('configure').setDescription('Configure separate free, DLC and deal alert channels')
    .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('type').setDescription('Alert stream').setRequired(true).addChoices({name:'Free games',value:'game'},{name:'DLCs & More',value:'loot'},{name:'Steam deals',value:'deals'},{name:'Free Weekend (Steam)',value:'weekend'}))
    .addChannelOption(o=>o.setName('channel').setDescription('Destination channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement))
    .addBooleanOption(o=>o.setName('enabled').setDescription('False disables this stream'));
  storeOption(configure);
  integer(configure,'min_discount','Minimum Steam discount; default 30',100);
  integer(configure,'min_positive','Minimum Steam positive reviews; default 80',100);
  integer(configure,'min_reviews','Minimum Steam review count; default 100',1000000);
  integer(configure,'reminder_hours','Expiry reminder lead time; default 6 hours',72);
  const setup=new SlashCommandBuilder().setName('setup').setDescription('Guided server notification setup').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const checknow=new SlashCommandBuilder().setName('checknow').setDescription('Check this server’s configured offers now').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const schedule=new SlashCommandBuilder().setName('schedule').setDescription('Quiet hours and daily digest for a server stream').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('type').setDescription('Stream').setRequired(true).addChoices(...['game','loot','weekend','deals'].map(value=>({name:value,value}))))
    .addStringOption(o=>o.setName('timezone').setDescription('IANA timezone; default America/Chicago').setMaxLength(80))
    .addIntegerOption(o=>o.setName('quiet_start').setDescription('Quiet start hour 0–23').setMinValue(0).setMaxValue(23))
    .addIntegerOption(o=>o.setName('quiet_end').setDescription('Quiet end hour 0–23; same start/end disables').setMinValue(0).setMaxValue(23))
    .addBooleanOption(o=>o.setName('digest').setDescription('One daily digest instead of individual posts'))
    .addIntegerOption(o=>o.setName('digest_hour').setDescription('Digest hour 0–23; default 18').setMinValue(0).setMaxValue(23));
  const exportsettings=new SlashCommandBuilder().setName('exportsettings').setDescription('Export this server’s alert configuration').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const importsettings=new SlashCommandBuilder().setName('importsettings').setDescription('Import server alert configuration from your export').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption(o=>o.setName('file').setDescription('JSON settings export').setRequired(true));
  return [free, deals, giveaways, alerts, stop, settings, preferences, wishlist, claimed, configure, notificationsettings, history, diagnostics, health, updates, setup, checknow, schedule, exportsettings, importsettings, prime, gamepass, new SlashCommandBuilder().setName('stores').setDescription('List supported giveaway platforms')].map(c => {
    const data=c.toJSON();
    delete data.dm_permission;
    const serverOnly=['alerts','stopalerts','configure','notificationsettings','schedule','exportsettings','importsettings','setup','checknow','history'].includes(data.name);
    data.integration_types=serverOnly ? [0] : [0,1]; // Guild install, user install
    data.contexts=serverOnly ? [0] : [0,1,2]; // Guild, bot DM, private/group DM
    return data;
  });
}

export function setupCard(wizard,id) {
  const c=wizard.config,step=wizard.step,prefix=`setup:${id}:`,rows=[];
  const titles=['Choose notification type','Choose a channel','Choose stores','Choose delivery schedule','Choose notification role','Review and save'];
  const embed=new EmbedBuilder().setTitle(`Setup • ${step+1}/6 • ${titles[step]}`).setColor(0x5865F2)
    .setDescription(`Type: ${wizard.kind}\nChannel: ${c.channel?'<#'+c.channel+'>':'Not selected'}\nStores: ${(c.platforms || ['all']).map(k=>PLATFORMS[k]).join(', ')}\nDelivery: ${c.digest?'Daily digest at 18:00':c.quietStart===22?'Quiet 22:00–07:00':'Immediate alerts'} (${c.timezone})\nRole: ${c.role?'<@&'+c.role+'>':'No ping'}\n\nNothing is saved until Save Setup. Checks preserve quiet hours, sent history and digest limits. Temporary-access weekends are separate from free-to-keep offers.`);
  if(step===0)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(prefix+'type').setPlaceholder('Notification category').addOptions(...['game','loot','weekend','deals'].map(value=>({value,label:({game:'100% Discount',loot:'DLCs & More',weekend:'Free Weekend — Steam',deals:'Steam Deals'})[value],default:value===wizard.kind})))));
  if(step===1)rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(prefix+'channel').setPlaceholder('Destination channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)));
  if(step===2)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(prefix+'stores').setPlaceholder(wizard.kind==='deals'?'Deals use Steam only':'Select stores').setMinValues(1).setMaxValues(Object.keys(PLATFORMS).length).addOptions(...Object.entries(PLATFORMS).map(([value,label])=>({value,label,default:(c.platforms || ['all']).includes(value)})))));
  if(step===3)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(prefix+'schedule').setPlaceholder('Delivery preset (America/Chicago)').addOptions({label:'Immediate — check every 30 minutes',value:'immediate'},{label:'Quiet hours — 22:00 to 07:00',value:'quiet'},{label:'Daily digest — 18:00',value:'digest'})));
  if(step===4)rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(prefix+'role').setPlaceholder('Optional role ping — leave blank for none').setMinValues(0).setMaxValues(1)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+'back').setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(step===0),new ButtonBuilder().setCustomId(prefix+(step===5?'save':'next')).setLabel(step===5?'Save Setup':'Next').setStyle(step===5?ButtonStyle.Success:ButtonStyle.Primary).setDisabled(step===1&&!c.channel),new ButtonBuilder().setCustomId(prefix+'cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)));
  return {embeds:[embed],components:rows};
}
export function addHistory(history,guild,event,now=Date.now()) {
  const cutoff=now-30*86400000;
  const entries=(history[guild] || []).filter(e=>e.time>=cutoff);
  entries.push({time:now,status:event.status,title:text(event.title,200),reason:text(event.reason,300),channel:event.channel?String(event.channel):null});
  history[guild]=entries.slice(-300);
}
export function diagnosticAdvice(error) {
  const message=String(error?.message || error);
  if(/403/.test(message))return 'Store denied access. Check regional restrictions, firewall/proxy and provider blocking.';
  if(/429/.test(message))return 'Rate limited. Wait before retrying; automatic source retries use a delay.';
  if(/timeout|timed out|abort/i.test(message) || /timeout/i.test(error?.name || ''))return 'Request timed out. Check network access and try this source again later.';
  if(/response changed|invalid|schema/i.test(message))return 'Store response format changed. The source parser may need an update.';
  if(/fetch failed|ENOTFOUND|ECONN|network|socket/i.test(message))return 'Connection/DNS failure. Check outbound HTTPS, DNS and your proxy.';
  return 'Source check failed. Review /health and bot.log; do not post tokens when sharing logs.';
}
export async function diagnosticResults(sources,selected='all') {
  const tests={steam:()=>sources.steamFree(),epic:()=>sources.epicFree(),gog:()=>sources.gogFree(),feed:()=>sources.feedOtherGames()};
  const keys=selected==='all'?Object.keys(tests):[selected];
  if(keys.some(k=>!tests[k]))throw new Error('Unknown diagnostic source');
  for(const key of ['steam-direct-free','epic-direct-free','gog-direct-free']) {
    if(selected==='all' || key.startsWith(selected+'-'))sources.cache.delete(key);
  }
  return Promise.all(keys.map(async key=>{const started=Date.now();try{const games=await tests[key]();return {source:key,ok:true,count:games.length,elapsed:Date.now()-started};}catch(error){return {source:key,ok:false,error:text(error.message,180),advice:diagnosticAdvice(error),elapsed:Date.now()-started};}}));
}
export function offerMatches(game, profile = {}) {
  const stores = profile.stores || ['all'];
  const platforms = String(game.platforms || '').toLowerCase();
  const storeNames = {'epic-games-store':'epic games store',itchio:'itch.io','drm-free':'drm-free'};
  const storeMatch = stores.includes('all') || stores.some(k => platforms.includes(storeNames[k] || k));
  const haystack = `${game.title || ''} ${game.description || ''}`.toLowerCase();
  const keywords = profile.keywords || [];
  return storeMatch && (!keywords.length || keywords.some(k => haystack.includes(k.toLowerCase())));
}
export function offerKey(game) {
  try {
    const url=new URL(game.open_giveaway_url || game.url);
    const steam=url.pathname.match(/\/app\/(\d+)/);
    if(url.hostname==='store.steampowered.com' && steam)return `steam:${steam[1]}:${game.type || 'Game'}`;
    url.search='';url.hash='';return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/,'')}:${game.type || 'Game'}`;
  }catch{return `id:${game.id}`;}
}
export function deliveryWindow(config,now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone || 'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=k=>parts.find(p=>p.type===k).value, hour=Number(get('hour')),day=`${get('year')}-${get('month')}-${get('day')}`;
  const start=config.quietStart,end=config.quietEnd;
  const quiet=Number.isInteger(start)&&Number.isInteger(end)&&start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end);
  return {quiet,day,hour,digestDue:config.digest && hour>=(config.digestHour ?? 18) && config.lastDigest!==day};
}
export const EXPORT_FIELDS=['channel','platform','platforms','minDiscount','minPositive','minReviews','reminderHours','minWorth','quality','theme','threads','links','react','publish','role','timezone','quietStart','quietEnd','digest','digestHour'];
export function cleanConfig(config) {
  const out=Object.fromEntries(EXPORT_FIELDS.filter(k=>config[k]!==undefined).map(k=>[k,config[k]]));
  if(out.platforms)out.platforms=normalizeStores(out.platforms);
  if(out.platform && !Object.hasOwn(PLATFORMS,out.platform))throw new Error('Invalid store');
  if(out.theme && !Object.hasOwn(THEMES,out.theme))throw new Error('Invalid theme');
  if(out.threads && !['none','below','inside'].includes(out.threads))throw new Error('Invalid thread setting');
  for(const k of ['quietStart','quietEnd','digestHour'])if(out[k]!==undefined && (!Number.isInteger(out[k]) || out[k]<0 || out[k]>23))throw new Error('Invalid schedule hour');
  if(out.timezone)new Intl.DateTimeFormat('en-US',{timeZone:out.timezone});
  return out;
}
export function deadline(game) {
  const raw = String(game.end_date || '');
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)){const t=Date.parse(raw);return Number.isFinite(t)?t:null;}
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const value = Date.parse(raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(value) ? value : null;
}
export function settingsCard(profile, user) {
  const select = new StringSelectMenuBuilder().setCustomId(`settings:${user}:stores`).setPlaceholder('Favorite stores')
    .setMinValues(1).setMaxValues(Object.keys(PLATFORMS).length).addOptions(Object.entries(PLATFORMS).map(([value,label]) => ({value,label,default:(profile.stores || ['all']).includes(value)})));
  const presets = new StringSelectMenuBuilder().setCustomId(`settings:${user}:deals`).setPlaceholder('Deal quality preset').addOptions(
    {label:'Standard: 30% off, 80% positive, 100 reviews',value:'standard'},
    {label:'Strict: 50% off, 90% positive, 500 reviews',value:'strict'},
    {label:'Big discounts: 75% off, 80% positive, 100 reviews',value:'deep'});
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`settings:${user}:hide`).setLabel(profile.hideClaimed !== false ? 'Show claimed offers' : 'Hide claimed offers').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`settings:${user}:dm`).setLabel(profile.wishlistDM ? 'Disable wishlist DMs' : 'Enable wishlist DMs').setStyle(ButtonStyle.Secondary));
  const embed = new EmbedBuilder().setTitle('Your game settings').setColor(0x5865F2).setDescription(
    `Stores: ${(profile.stores || ['all']).map(k=>PLATFORMS[k]).join(', ')}\nGenre/keyword matches: ${(profile.keywords || []).join(', ') || 'All'}\nHide claimed: ${profile.hideClaimed !== false}\nWishlist DMs: ${!!profile.wishlistDM}\nDeal filters: ${profile.minDiscount || 30}% off, ${profile.minPositive || 80}% positive, ${profile.minReviews || 100} reviews\n\nUse /preferences keywords:survival,co-op to match genres/words in offer titles and descriptions. Use /configure for server alert channels.`);
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(select),new ActionRowBuilder().addComponents(presets),buttons]};
}

export function offerCard(games, session, sessionId) {
  const index = Math.max(0, Math.min(session.index, games.length - 1));
  session.index = index;
  const game = games[index];
  const embed = game ? giveawayEmbed(game) : new EmbedBuilder().setTitle('No matching offers').setColor(0x5865F2)
    .setDescription('Try another store or offer type. Unknown regular values are excluded from 100% Discount.');
  embed.setFooter({ text: `${PLATFORMS[session.store]} • ${session.kind === 'weekend'?'Free Weekend':session.kind === 'game' ? '100% Discount' : 'DLCs & More'} • ${games.length ? index + 1 : 0}/${games.length} • ${game?.source || 'GamerPower'}` });
  const counts = session.counts || {};
  const stores = new StringSelectMenuBuilder().setCustomId(`browse:${sessionId}:store`).setPlaceholder('🌐 For you — filter by store')
    .addOptions(Object.entries(PLATFORMS).map(([value, name]) => ({label: text((value === 'all' ? '🌐 For you' : name) + (counts[value] !== undefined ? ` (${counts[value]})` : ''),100), value, default: value === session.store})));
  const types = new StringSelectMenuBuilder().setCustomId(`browse:${sessionId}:type`).setPlaceholder('Filter by type').addOptions(
    {label:'100% Discount — normally paid games', value:'game', default:session.kind === 'game'},
    {label:'DLCs & More — free add-ons and loot', value:'loot', default:session.kind === 'loot'},
    {label:'Free Weekend — temporary Steam access',value:'weekend',default:session.kind==='weekend'});
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`browse:${sessionId}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
    new ButtonBuilder().setCustomId(`browse:${sessionId}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index >= games.length - 1),
    new ButtonBuilder().setCustomId(`browse:${sessionId}:claimed`).setLabel('Mark claimed').setStyle(ButtonStyle.Success).setDisabled(!game),
    new ButtonBuilder().setCustomId(`browse:${sessionId}:claimlinks`).setLabel('All claim links').setStyle(ButtonStyle.Secondary).setDisabled(!games.length));
  session.claimLinks=games.slice(0,15).map(g=>`${text(g.title,90)} — ${g.open_giveaway_url}`).join('\n').slice(0,1900);
  session.current = game ? String(game.id) : null;
  return {embeds:[embed], components:[...(game ? claimRows(game) : []), new ActionRowBuilder().addComponents(stores), new ActionRowBuilder().addComponents(types), nav]};
}

export const THEMES = {default:'Default Theme',noimages:'No photos',info:'More info',compact:'More info, less images',simple:'Keep it simple',image:'Images',link:'Just the link',bare:'Bare minimum',text:'Text only',advanced:'Advanced — claim details'};
export function subscriptionCard(service) {
  const prime=service==='prime';
  const url=prime?'https://luna.amazon.com/claims/':'https://www.xbox.com/en-US/xbox-game-pass/games';
  const embed=new EmbedBuilder().setTitle(prime?'Prime Gaming / Amazon Luna claims':'Xbox Game Pass catalog').setColor(prime?0x9146FF:0x107C10)
    .setDescription(prime?'Browse the official Amazon game claims page while signed in. Prime membership, regional availability and individual offer terms apply.':'Browse the official Xbox Game Pass catalog. Select PC/console and your subscription plan; availability varies by plan and region.')
    .addFields({name:'Subscription category',value:'These are membership benefits, not public 100% discounts. The live game list is loaded on the official site; the bot does not currently have a verified catalog feed.'})
    .setURL(url);
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(prime?'Open Amazon game claims':'Browse Game Pass games').setStyle(ButtonStyle.Link).setURL(url))]};
}
export function normalizeStores(stores) {
  const selected=[...new Set((Array.isArray(stores)?stores:[stores || 'all']).filter(k=>Object.hasOwn(PLATFORMS,k)))];
  return !selected.length || selected.includes('all')?['all']:selected;
}
export function notificationHome(streams,guild) {
  const labels={game:'🎁 100% Discount',loot:'📦 DLCs & More',deals:'💸 Steam Deals',weekend:'📅 Free Weekend'};
  const active=Object.keys(streams).filter(k=>labels[k]);
  const embed=new EmbedBuilder().setTitle('Your Active Notifications').setColor(0x5865F2)
    .setDescription(active.length?'Edit your notification settings by clicking a category below.':'No active notifications yet. Use /configure to select a channel.')
    .addFields({name:'Add Notifications',value:'Use /configure for 100% Discount, DLCs & More or Steam Deals. Prime Gaming and Game Pass: use the subscription buttons below. Live catalog notifications are not yet connected. Free Weekend uses a limited Steam store scan.'});
  const rows=[];
  if(active.length)rows.push(new ActionRowBuilder().addComponents(...active.map(kind=>new ButtonBuilder().setCustomId(`notify:${guild}:${kind}:tab-category`).setLabel(labels[kind]).setStyle(ButtonStyle.Primary))));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`subscription:prime`).setLabel('👑 Prime Gaming').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`subscription:gamepass`).setLabel('🎮 Game Pass').setStyle(ButtonStyle.Secondary)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`notify:${guild}:game:help`).setLabel('Need help?').setStyle(ButtonStyle.Secondary)));
  return {embeds:[embed],components:rows};
}
export function notificationPanel(config,guild,kind,tab='category') {
  const name=kind==='weekend'?'Free Weekend':kind==='game'?'100% Discount':kind==='loot'?'DLCs & More':'Steam Deals';
  const title={category:'Settings',filters:'Filter Settings',display:'Display Settings',notifications:'Notification Settings',more:'More'};
  const prefix=`notify:${guild}:${kind}:`;
  const embed=new EmbedBuilder().setTitle(`${name} › ${title[tab] || 'Settings'}`).setColor(0x5865F2);
  const rows=[];
  const select=(action,placeholder,options)=>new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(prefix+action).setPlaceholder(placeholder).addOptions(options));
  if(tab==='category') {
    embed.setDescription(`Notification channel: <#${config.channel}>\nChoose the settings you want to change.`);
    rows.push(new ActionRowBuilder().addComponents(...['filters','display','notifications','more'].map(page=>new ButtonBuilder().setCustomId(prefix+'tab-'+page).setLabel(title[page]).setStyle(ButtonStyle.Primary))));
  }else if(tab==='filters') {
    embed.setDescription('There are a lot of free games out there, some more interesting than others. Choose which offers you want to see.')
      .addFields({name:'Only from these stores',value:normalizeStores(config.platforms || [config.platform || 'all']).map(k=>PLATFORMS[k]).join(', ')},
        {name:'Minimum original price',value:`$${config.minWorth || 0}+ (source-reported value)`},
        {name:'Additional filters',value:config.quality?'Hide poorly rated / unknown games (direct Steam links only)':'Show all qualities'});
    const stores=normalizeStores(config.platforms || [config.platform || 'all']);
    const storeRow=select('store','Select one or more stores',Object.entries(PLATFORMS).map(([value,label])=>({value,label,default:stores.includes(value)})));
    storeRow.components[0].setMinValues(1).setMaxValues(Object.keys(PLATFORMS).length);rows.push(storeRow);
    rows.push(select('price','Minimum original price',[0,1,3,10].map(n=>({value:String(n),label:n===0?'Everything':n===1?'Almost Everything':n===3?'Default':'Big fish',description:n===0?'All offers with a known positive value':`Only games worth $${n.toFixed(2)} or more`,default:(config.minWorth || 0)===n}))));
    rows.push(select('quality','Additional filters',[{label:'Show bad quality games',description:'Include every quality level',value:'all',default:!config.quality},{label:'Hide bad quality games',description:'Steam 80% positive / 100 reviews; unknown omitted',value:'good',default:!!config.quality}]));
  }else if(tab==='display') {
    embed.setDescription('Customize the appearance of new offer messages.')
      .addFields({name:'Select theme',value:THEMES[config.theme || 'info']},{name:'Thread behavior',value:config.threads || 'No threads'},
      {name:'More options',value:'Claim links require manual redemption. Auto Publish applies to announcement channels. Custom avatar/name is not available.'});
    rows.push(select('theme','Select theme',Object.entries(THEMES).map(([value,label])=>({value,label,default:value===(config.theme || 'info')}))));
    rows.push(select('threads','Thread behavior',[{label:'No threads',value:'none',description:'Send a message in your channel.'},{label:'Thread below',value:'below',description:'Send a message and start a thread below it.'},{label:'Message in thread',value:'inside',description:'Create a new thread and post the offer inside.'}].map(o=>({...o,default:o.value===(config.threads || 'none')}))));
    rows.push(new ActionRowBuilder().addComponents(...['links','react','publish'].map(action=>{
      const enabled=action==='links'?config.links!==false:!!config[action];
      return new ButtonBuilder().setCustomId(prefix+action).setLabel(`${action==='links'?'Claim Buttons':action==='react'?'Auto Reaction':'Auto Publish'} ${enabled?'Enabled':'Disabled'}`).setStyle(enabled?ButtonStyle.Success:ButtonStyle.Secondary);
    })));
  }else if(tab==='notifications') {
    embed.setDescription('Pick a role to ping when a new offer is posted. The role must be mentionable, or the bot needs permission to mention it.').addFields({name:'Selected role',value:config.role?`<@&${config.role}>`:'No role selected'});
    rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(prefix+'role').setPlaceholder('Pick a notification role').setMinValues(0).setMaxValues(1)));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+'tab-notifications').setLabel('Refresh List').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(prefix+'addrole').setLabel('Add Role').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(prefix+'clearrole').setLabel('Clear Role').setStyle(ButtonStyle.Secondary)));
  }else if(tab==='more') {
    embed.addFields({name:'Test Message',value:'Send a test message with your configured display options. Tests do not ping roles.'},{name:'Resend Notifications',value:'Reset sent history. Current offers will post on the next check and may ping your configured role.'});
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+'test').setLabel('Send Test').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(prefix+'resend').setLabel('Resend').setStyle(ButtonStyle.Secondary)));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+(tab==='category'?'root':'tab-category')).setLabel('‹ Back').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(prefix+'help').setLabel('Need help?').setStyle(ButtonStyle.Secondary)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+'preview').setLabel('Preview').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(prefix+'save').setLabel('Save Changes').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(prefix+'cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)));
  return {embeds:[embed],components:rows};
}
export function themedOffer(game,config={}) {
  const theme=config.theme || 'info',url=game.open_giveaway_url;
  let payload={embeds:[giveawayEmbed(game)],components:config.links===false?[]:claimRows(game)};
  const e=payload.embeds[0];
  if(['noimages','compact','simple','default'].includes(theme))e.setImage(null);
  if(['simple','default','image'].includes(theme)) {e.setDescription(theme==='image'?'Free offer — open the claim page.':text(game.description,300) || 'Free offer');e.setFields({name:'Free until (source)',value:text(game.end_date,100)||'Unknown'});}
  if(theme==='advanced')e.addFields({name:'Offer ID',value:String(game.id ?? 'test')});
  if(['link','bare','text'].includes(theme)) {
    payload.embeds=[];
    payload.content=theme==='link'?url:theme==='bare'?`${text(game.title,200)} — ${url}`:`**${escapeMarkdown(text(game.title,200))}**\n${text(game.description,800)}\n${game.worth || 'Unknown value'} → Free • ${game.end_date || 'Unknown deadline'}\n${url}`;
  }
  return payload;
}

export function parseState(raw) {
  // Python saved Discord channel IDs as numbers; recover original JSON digits
  // before JavaScript's floating-point representation can round the snowflake.
  return JSON.parse(raw, (key, value, context) => key === 'channel' && typeof value === 'number'
    ? context.source : value);
}

export async function main() {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token || token === 'PASTE_YOUR_BOT_TOKEN_HERE') throw new Error('Edit .env and add DISCORD_TOKEN, then restart.');
  const statePath = join(ROOT, 'state.json');
  const state = existsSync(statePath) ? parseState(readFileSync(statePath, 'utf8')) : { channels: {} };
  if (!state.channels || typeof state.channels !== 'object') throw new Error('Invalid state.json; restore a backup.');
  state.users ??= {}; state.streams ??= {};state.history ??= {};
  const audit=(guild,event)=>{if(!guild)return;addHistory(state.history,guild,event);save();};
  const profileFor = user => state.users[user] ??= {stores:['all'],keywords:[],claimed:[],wishlist:[],wishlistSeen:[],hideClaimed:true,wishlistDM:false};
  const save = () => { writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2)); renameSync(statePath + '.tmp', statePath); };
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const sources = new Sources(), cooldown = new Map(), sessions = new Map(), drafts=new Map(),wizards=new Map(),manualChecks=new Map();
  const browse = async (session, id) => {
    const all = await sources.giveaways('all',session.kind), profile = profileFor(session.user);
    const visible = all.filter(g => (profile.hideClaimed === false || !(profile.claimed || []).includes(String(g.id))) && offerMatches(g,{...profile,stores:['all']}));
    session.counts = Object.fromEntries(Object.keys(PLATFORMS).map(k=>[k,visible.filter(g=>offerMatches(g,{stores:[k]})).length]));
    let games = visible.filter(g=>offerMatches(g,{stores:session.store === 'all' ? profile.stores : [session.store]}));
    if (session.search) games = games.filter(g => String(g.title).toLowerCase().includes(session.search.toLowerCase()));
    const payload=offerCard(games,session,id);
    const failed=[...sources.health].filter(([name,h])=>!h.ok && ['Steam','Epic','GOG','GamerPower'].includes(name)).map(([name])=>name);
    if(failed.length)payload.embeds[0].addFields({name:'Partial results',value:`Unavailable: ${failed.join(', ')}. Working stores are still shown; /health has details.`});
    return payload;
  };
  const sendConfigured = async (channel,payload,config={},title='Game offer',ping=true) => {
    const roles=config.role && ping?[config.role]:[];
    payload={...payload,content:[roles.length?`<@&${config.role}>`:'',payload.content || ''].filter(Boolean).join('\n') || undefined,allowedMentions:{parse:[],roles}};
    let message;
    if(config.threads==='inside') {
      const thread=await channel.threads.create({name:text(title,100),autoArchiveDuration:1440});message=await thread.send(payload);
    }else {message=await channel.send(payload);if(config.threads==='below')await message.startThread({name:text(title,100),autoArchiveDuration:1440});}
    if(config.react)try{await message.react('🎁');}catch(error){log(`Auto reaction unavailable: ${error.name}`);}
    if(config.publish && message.channel.type===ChannelType.GuildAnnouncement)try{await message.crosspost();}catch(error){log(`Auto publish unavailable: ${error.name}`);}
    audit(channel.guildId,{status:'posted',title,reason:'Message delivered',channel:message.channelId});
    return message;
  };
  const recordPost=(config,game,message)=>{config.posts ??= {};const end=deadline(game);config.posts[offerKey(game)]={channel:message.channelId,id:message.id,end,title:game.title};};
  const expirePosts=async config=>{for(const post of Object.values(config.posts || {})){if(!post.end || post.end>Date.now() || post.expired)continue;try{const channel=await client.channels.fetch(post.channel);const message=await channel.messages.fetch(post.id);await message.edit({content:`EXPIRED • ${text(post.title,200)}`,embeds:[],components:[],allowedMentions:{parse:[]}});post.expired=true;audit(channel.guildId,{status:'expired',title:post.title,reason:'Known deadline passed; message controls removed',channel:post.channel});save();}catch(error){log(`Expired message update failed: ${error.name}`);}}};
  const sendDigest=async(channel,config,games,window,deals)=>{
    const active=games.filter(g=>!deadline(g) || deadline(g)>Date.now());
    if(active.length){const lines=active.map(g=>`${g.title} — ${deals?g.price+' / '+g.discount+'% off':'Free offer'} — ${g.url || g.open_giveaway_url}`);
      const sent=await sendConfigured(channel,{content:`Daily game digest • ${window.day} • ${active.length} new offers`,files:[new AttachmentBuilder(Buffer.from(lines.join('\n')),{name:'daily-game-digest.txt'})]},config,'Daily game digest');
      for(const g of active){config.seen.push(deals?`${g.id}:${g.discount}:${g.price}`:offerKey(g));}
    }
    config.lastDigest=window.day;save();
  };
  const filterOffers=async(games,config,guild=null)=>{
    const filtered=[];
    for(const g of games) {
      const worth=g.regular_value ?? Number(String(g.worth || '').replace(/[$,]/g,''));
      if((config.minWorth || 0)>0 && (!Number.isFinite(worth) || worth<config.minWorth)){audit(guild,{status:'skipped',title:g.title,reason:'Below minimum original-value filter or value unavailable',channel:config.channel});continue;}
      if(config.quality) {
        const match=String(g.open_giveaway_url || '').match(/^https:\/\/store\.steampowered\.com\/app\/(\d+)/);
        if(!match){audit(guild,{status:'skipped',title:g.title,reason:'Quality filter requires a direct Steam link',channel:config.channel});continue;}
        try{const reviews=await sources.cached('reviews:'+match[1],3600000,()=>sources.json(`https://store.steampowered.com/appreviews/${match[1]}`,{json:1,language:'all',filter:'all',purchase_type:'all',num_per_page:1}));if(!qualifyReviews(g,reviews,80,100)){audit(guild,{status:'skipped',title:g.title,reason:'Below quality/review-count filter',channel:config.channel});continue;}}catch{audit(guild,{status:'skipped',title:g.title,reason:'Review verification unavailable',channel:config.channel});continue;}
      }
      filtered.push(g);
    }
    return filtered;
  };
  let stopping = false, alertTimer, checking = false;
  const checkAlerts = async (targetGuild=null) => {
    if (checking || stopping) return false;
    checking = true;
    try {
      for (const [guildId, settings] of Object.entries(state.channels)) {
        if(targetGuild && guildId!==targetGuild)continue;
        if (stopping) break;
        if (state.channels[guildId] !== settings || state.streams[guildId]?.game) continue;
        const platform = settings.platform || 'steam';
        if (!Object.hasOwn(PLATFORMS, platform)) continue;
        try {
          const games = await sources.giveaways(platform), channel = await client.channels.fetch(settings.channel);
          if (!channel?.isTextBased() || !channel.send) throw new Error('Alert channel unavailable');
          settings.seen ??= []; settings.reminded ??= [];
          for (const game of games) {
            if (stopping || state.channels[guildId] !== settings) break;
            const id=offerKey(game);
            if (!settings.seen.includes(id) && !settings.seen.includes(String(game.id))) {
              await channel.send({ embeds: [giveawayEmbed(game)], components: [...claimRows(game),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`claimoffer:${String(game.id)}`).setLabel('Mark claimed').setStyle(ButtonStyle.Success))] });
              settings.seen.push(id);audit(guildId,{status:'posted',title:game.title,reason:'Free-game message delivered',channel:settings.channel});save();
            }
            const end=deadline(game);
            if(end && end>Date.now() && end-Date.now()<=6*3600000 && !settings.reminded.includes(id)) {
              await channel.send({content:`⏰ Expiring soon: **${escapeMarkdown(game.title)}**. Deadline ${game.end_date} (UTC assumed; verify claim page).`,components:claimRows(game)});settings.reminded.push(id);save();
            }
          }
        } catch (error) { log(`Alerts for ${guildId}: ${error.name}: ${error.message}`);audit(guildId,{status:'failed',title:'Free-game alerts',reason:diagnosticAdvice(error),channel:settings.channel}); }
      }
      for (const [guild, streams] of Object.entries(state.streams)) {
        if(targetGuild && guild!==targetGuild)continue;
        for (const [kind, config] of Object.entries(streams)) {
          if (stopping) break;
          try {
            const channel = await client.channels.fetch(config.channel);
            if (!channel?.send) continue;
            config.seen ??= []; config.reminded ??= [];
            await expirePosts(config);
            const window=deliveryWindow(config);
            if(window.quiet || (config.digest && !window.digestDue)){audit(guild,{status:'skipped',title:kind+' stream',reason:window.quiet?'Quiet hours active':'Daily digest is not due or already delivered',channel:config.channel});continue;}
            if (kind === 'deals') {
              const result = await sources.deals(1,'',config.minDiscount || 30,config.minPositive || 80,config.minReviews || 100);
              if(config.digest){const fresh=result.games.filter(g=>!config.seen.includes(`${g.id}:${g.discount}:${g.price}`));await sendDigest(channel,config,fresh,window, true);continue;}
              for (const game of result.games.slice(0,10)) {
                const key = `${game.id}:${game.discount}:${game.price}`;
                if(config.seen.includes(key)){audit(guild,{status:'skipped',title:game.title,reason:'Already posted this price/discount',channel:config.channel});continue;}
                const embed = new EmbedBuilder().setTitle(text(game.title,256)).setURL(game.url).setColor(0xF1C40F)
                  .setDescription(`${game.price} (was ${game.original}) • ${game.discount}% off\n${game.positive.toFixed(1)}% positive • ${game.reviews} reviews`);
                await sendConfigured(channel,{embeds:[embed],components:config.links===false?[]:steamRows([game])},config,game.title);config.seen.push(key);save();
              }
            } else {
              const games = await filterOffers(await sources.selectedGiveaways(config.platforms || [config.platform || 'all'],kind),config,guild);
              if(config.digest){const fresh=games.filter(g=>!config.seen.includes(offerKey(g)) && !config.seen.includes(String(g.id)));await sendDigest(channel,config,fresh,window,false);continue;}
              for (const game of games) {
                const id=offerKey(game);
                const mark = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`claimoffer:${String(game.id)}`).setLabel('Mark claimed').setStyle(ButtonStyle.Success));
                if (!config.seen.includes(id) && !config.seen.includes(String(game.id))) {const sent=await sendConfigured(channel,{...themedOffer(game,config),components:[...(config.links===false?[]:claimRows(game)),mark]},config,game.title);recordPost(config,game,sent);config.seen.push(id);save();}else audit(guild,{status:'skipped',title:game.title,reason:'Duplicate offer already posted',channel:config.channel});
                const end=deadline(game), remaining=end-Date.now();
                if (end && remaining > 0 && remaining <= (config.reminderHours || 6)*3600000 && !config.reminded.includes(id)) {
                  await channel.send({content:`⏰ Expiring soon: **${escapeMarkdown(game.title)}**. Reported deadline: ${game.end_date} (UTC assumed; verify claim page).`,components:claimRows(game)});
                  config.reminded.push(id);save();
                }
              }
            }
          } catch(error) {log(`Stream ${guild}/${kind}: ${error.name}`);audit(guild,{status:'failed',title:kind+' stream',reason:diagnosticAdvice(error),channel:config.channel});}
        }
      }
      // Personal wishlist notifications are opt-in, with a bounded rotating batch.
      const watchers=(targetGuild?[]:Object.entries(state.users)).filter(([,p])=>p.wishlistDM && p.wishlist?.length);
      const allFree=watchers.length ? await sources.giveaways('all') : [];
      const jobs=watchers.flatMap(([user,p])=>p.wishlist.map(name=>({user,p,name})));
      const start=(state.watchCursor || 0) % Math.max(jobs.length,1);
      for(let offset=0;offset<Math.min(10,jobs.length);offset++) {
        const {user,p,name}=jobs[(start+offset)%jobs.length];
        p.wishlistSeen ??= [];
          try {
            const free=allFree.filter(g=>String(g.title).toLowerCase().includes(name.toLowerCase()) && !(p.claimed || []).includes(String(g.id)));
            const deals=(await sources.deals(1,name,p.minDiscount || 30,p.minPositive || 80,p.minReviews || 100).catch(()=>({games:[]}))).games
              .filter(g=>g.title.toLowerCase().includes(name.toLowerCase()));
            const target=await client.users.fetch(user);
            for (const g of free) {
              const key=`free:${g.id}`;if(p.wishlistSeen.includes(key))continue;
              await target.send({content:`Wishlist match: ${name}`,embeds:[giveawayEmbed(g)],components:claimRows(g)});p.wishlistSeen.push(key);save();
            }
            for (const g of deals.slice(0,3)) {
              const key=`deal:${g.id}:${g.discount}:${g.price}`;if(p.wishlistSeen.includes(key))continue;
              await target.send({content:`Wishlist discount: **${escapeMarkdown(g.title)}** — ${g.price}, ${g.discount}% off, ${g.positive.toFixed(1)}% positive.`,components:steamRows([g])});p.wishlistSeen.push(key);save();
            }
          } catch(error) {log(`Wishlist notification failed: ${error.name}`);}
      }
      if(jobs.length){state.watchCursor=(start+Math.min(10,jobs.length))%jobs.length;save();}
    } catch(error) {log(`Background check failed: ${error.name}`);} finally { checking = false; }
    return true;
  };
  client.on(Events.InteractionCreate, async i => {
    if((i.isButton() || i.isStringSelectMenu() || i.isChannelSelectMenu() || i.isRoleSelectMenu()) && i.customId.startsWith('setup:')) {
      await i.deferUpdate();
      try {
        const [,id,action]=i.customId.split(':'),w=wizards.get(id);
        if(!w || Date.now()-w.created>30*60000){await i.editReply({content:'Setup expired; run /setup again.',embeds:[],components:[]});return;}
        if(w.user!==i.user.id || w.guild!==i.guildId || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await i.followUp({content:'Only the server manager who opened setup can change it.',flags:MessageFlags.Ephemeral});return;}
        const c=w.config;
        if(action==='type' && ['game','loot','weekend','deals'].includes(i.values?.[0]))w.kind=i.values[0];
        if(action==='channel'){const ch=await i.guild.channels.fetch(i.values[0]);const me=await i.guild.members.fetchMe();if(!ch?.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles]))throw new Error('Channel requires View, Send, Embed Links and Attach Files permissions for the bot.');c.channel=ch.id;}
        if(action==='stores'){c.platforms=normalizeStores(i.values);c.platform=c.platforms[0];}
        if(action==='schedule'){c.digest=i.values[0]==='digest';c.quietStart=i.values[0]==='quiet'?22:0;c.quietEnd=i.values[0]==='quiet'?7:0;c.digestHour=18;}
        if(action==='role'){const role=i.values[0]?await i.guild.roles.fetch(i.values[0]):null;if(role && !role.mentionable && !i.guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone))throw new Error('Choose a mentionable role or allow the bot to mention it.');c.role=role?.id || null;}
        if(action==='back')w.step=Math.max(0,w.step-1);
        if(action==='next'){if(w.step===1&&!c.channel)throw new Error('Select a destination channel.');w.step=Math.min(5,w.step+1);}
        if(action==='cancel'){wizards.delete(id);await i.editReply({content:'Setup cancelled; no settings saved.',embeds:[],components:[]});return;}
        if(action==='save') {
          if(!c.channel)throw new Error('Select a destination channel.');
          const ch=await i.guild.channels.fetch(c.channel),me=await i.guild.members.fetchMe();if(!ch?.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles]))throw new Error('Bot channel permissions changed; fix them before saving.');
          if(c.role){const role=await i.guild.roles.fetch(c.role);if(!role || (!role.mentionable && !me.permissions.has(PermissionFlagsBits.MentionEveryone)))throw new Error('Notification role is no longer available/mentionable.');}
          if(w.kind==='deals'){c.platform='steam';c.platforms=['steam'];}
          if(w.kind==='weekend'){c.platform='steam';c.platforms=['steam'];}
          state.streams[i.guildId] ??= {};const prior=state.streams[i.guildId][w.kind];state.streams[i.guildId][w.kind]={...prior,...c,seen:prior?.channel===c.channel?(prior.seen || []):[],reminded:prior?.channel===c.channel?(prior.reminded || []):[]};save();wizards.delete(id);
          await i.editReply({content:`Setup saved for ${w.kind} in <#${c.channel}>. Use /checknow to check now, /schedule for custom hours/timezone, or /settings to edit.`,embeds:[],components:[]});return;
        }
        await i.editReply(setupCard(w,id));
      }catch(error){await i.followUp({content:text(error.message,1000),flags:MessageFlags.Ephemeral});}
      return;
    }
    if(i.isButton() && i.customId.startsWith('updates:')) {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const app=await client.application.fetch();if(i.user.id!==app.owner?.id){await i.editReply('Only the application owner can use update controls.');return;}
      if(!process.send){await i.editReply('Restart using Start-Bot.bat to connect the supervisor.');return;}
      const action=i.customId.split(':')[1];
      await i.editReply(action==='rollback'?'Rollback requested; restarting with backup.':'Update check requested.');
      process.send({type:action==='rollback'?'rollback':'update-check'});return;
    }
    if(i.isButton() && i.customId.startsWith('subscription:')) {
      await i.reply({...subscriptionCard(i.customId.split(':')[1]),flags:MessageFlags.Ephemeral});return;
    }
    if ((i.isButton() || i.isStringSelectMenu() || i.isRoleSelectMenu()) && i.customId.startsWith('notify:')) {
      const [,guild,kind,action]=i.customId.split(':');
      if(i.guildId!==guild || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {await i.reply({content:'Manage Server permission required.',flags:MessageFlags.Ephemeral});return;}
      await i.deferUpdate();
      try {
        if(action==='root'){await i.editReply(notificationHome(state.streams[guild] || {},guild));return;}
        if(action==='help'){await i.followUp({content:'Use /configure to choose a channel. Click an active notification category, then Filter Settings, Display Settings, Notification Settings or More. Personal preferences: /settings scope:personal. Thread/role/publish options require the relevant Discord permissions.',flags:MessageFlags.Ephemeral});return;}
        const draftKey=`${guild}:${kind}:${i.user.id}`;
        const saved=state.streams[guild]?.[kind];
        if(saved && !drafts.has(draftKey))drafts.set(draftKey,structuredClone(saved));
        const c=drafts.get(draftKey);if(!c){await i.editReply({content:'Configure this stream first with /configure.',embeds:[],components:[]});return;}
        if(action==='save'){state.streams[guild][kind]=c;drafts.delete(draftKey);save();await i.editReply(notificationPanel(c,guild,kind));return;}
        if(action==='cancel'){drafts.delete(draftKey);await i.editReply(notificationPanel(saved,guild,kind));return;}
        if(action==='preview'){const sample={id:'preview',title:'Notification preview',type:'Game',worth:'$19.99',description:'Private preview — no server message, role ping, thread or publication is sent.',platforms:'Steam',end_date:'N/A',open_giveaway_url:'https://store.steampowered.com/'};await i.followUp({...themedOffer(sample,c),flags:MessageFlags.Ephemeral});return;}
        let tab='category';
        if(action.startsWith('tab-'))tab=action.slice(4);
        if(action==='store'){c.platforms=normalizeStores(i.values);c.platform=c.platforms[0];tab='filters';}
        if(action==='price'){c.minWorth=Number(i.values[0]);tab='filters';}
        if(action==='quality'){c.quality=i.values[0]==='good';tab='filters';}
        if(action==='theme'){c.theme=i.values[0];tab='display';}
        if(action==='threads'){c.threads=i.values[0];tab='display';}
        if(['links','react','publish'].includes(action)){c[action]=action==='links'?c.links===false:!c[action];tab='display';}
        if(action==='role'){const role=i.values[0]?await i.guild.roles.fetch(i.values[0]):null;
          if(role && !role.mentionable && !i.guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone))throw new Error('Role must be mentionable or bot needs Mention Everyone permission.');
          c.role=role?.id || null;tab='notifications';}
        if(action==='clearrole'){c.role=null;tab='notifications';}
        if(action==='addrole'){if(!i.memberPermissions.has(PermissionFlagsBits.ManageRoles))throw new Error('You need Manage Roles to create a role.');const role=await i.guild.roles.create({name:'Free Games',mentionable:true,reason:'Free games notification role requested by server manager'});c.role=role.id;tab='notifications';}
        if(action==='test'){const channel=await client.channels.fetch(c.channel);const sample={id:'test',title:'Test game notification',type:'Game',worth:'$19.99',description:'This is a test of your notification settings, not a real offer.',platforms:'Steam',end_date:'N/A',open_giveaway_url:'https://store.steampowered.com/'};await sendConfigured(channel,themedOffer(sample,c),c,'Test game notification',false);tab='more';}
        if(action==='resend'){c.seen=[];c.reminded=[];tab='more';}
        drafts.set(draftKey,c);await i.editReply(notificationPanel(c,guild,kind,tab));
      }catch(error){await i.followUp({content:text(error.message,1500),flags:MessageFlags.Ephemeral});}
      return;
    }
    if ((i.isButton() || i.isStringSelectMenu()) && (i.customId.startsWith('settings:') || i.customId.startsWith('claimoffer:'))) {
      try {
        if(i.customId.startsWith('claimoffer:')) {
          const id=i.customId.slice('claimoffer:'.length),p=profileFor(i.user.id);p.claimed ??= [];
          if(!p.claimed.includes(id))p.claimed.push(id);save();
          await i.reply({content:'Marked claimed for you. Your /free browser will hide it.',flags:MessageFlags.Ephemeral});return;
        }
        const [,owner,action]=i.customId.split(':');
        if(owner!==i.user.id){await i.reply({content:'Open your own /settings panel.',flags:MessageFlags.Ephemeral});return;}
        const p=profileFor(owner);
        if(action==='stores')p.stores=i.values.filter(k=>Object.hasOwn(PLATFORMS,k));
        if(action==='hide')p.hideClaimed=p.hideClaimed===false;
        if(action==='dm')p.wishlistDM=!p.wishlistDM;
        if(action==='deals') {
          const presets={standard:[30,80,100],strict:[50,90,500],deep:[75,80,100]};
          if(presets[i.values[0]])[p.minDiscount,p.minPositive,p.minReviews]=presets[i.values[0]];
        }
        save();await i.update(settingsCard(p,owner));
      }catch(error){log(`Settings failed: ${error.name}`);}
      return;
    }
    if ((i.isStringSelectMenu() || i.isButton()) && i.customId.startsWith('browse:')) {
      const [, id, action] = i.customId.split(':');
      const session = sessions.get(id);
      if (!session || Date.now() - session.created > 24 * 60 * 60 * 1000) {
        await i.reply({content:'This browser expired. Run /free again.',flags:MessageFlags.Ephemeral}); return;
      }
      if (session.user !== i.user.id) {
        await i.reply({content:'Run /free to open your own game browser.',flags:MessageFlags.Ephemeral}); return;
      }
      if(action==='claimlinks'){await i.reply({content:session.claimLinks || 'No offers.',flags:MessageFlags.Ephemeral});return;}
      await i.deferUpdate();
      try {
        if (action === 'store' && Object.hasOwn(PLATFORMS, i.values?.[0])) {session.store=i.values[0];session.index=0;}
        if (action === 'type' && ['game','loot','weekend'].includes(i.values?.[0])) {session.kind=i.values[0];session.index=0;}
        if (action === 'claimed' && session.current) {const p=profileFor(i.user.id);p.claimed ??= [];if(!p.claimed.includes(session.current))p.claimed.push(session.current);save();}
        if (action === 'next') session.index++;
        if (action === 'prev') session.index--;
        await i.editReply(await browse(session,id));
      } catch(error) {log(`Offer browser failed: ${error.name}`);await i.followUp({content:'Could not load offers. Try again shortly.',flags:MessageFlags.Ephemeral});}
      return;
    }
    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    // Discord requires an initial acknowledgement within three seconds.
    try {
      const privateCommand=['settings','preferences','wishlist','claimed','configure','alerts','stopalerts','stores','notificationsettings','health','updates','schedule','exportsettings','importsettings','setup','checknow','history','diagnostics'].includes(cmd);
      await i.deferReply(privateCommand ? {flags:MessageFlags.Ephemeral} : {});
    } catch(error) {
      log(`Command ${cmd} acknowledgement failed: ${error.name}; run only one bot instance and check connection latency.`);
      return;
    }
    const respond=async payload => {
      if(typeof payload==='string')return i.editReply(payload);
      const {flags,...body}=payload;
      return i.editReply(body);
    };
    try {
      const personal=profileFor(i.user.id);
      if(cmd==='setup' || cmd==='checknow') {
        if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond('Manage Server permission required in a server.');return;}
        if(cmd==='setup'){for(const [id,w] of wizards)if(Date.now()-w.created>30*60000)wizards.delete(id);const id=randomUUID(),w={user:i.user.id,guild:i.guildId,created:Date.now(),step:0,kind:'game',config:{platforms:['all'],platform:'all',timezone:'America/Chicago',digest:false,digestHour:18,reminderHours:6,minDiscount:30,minPositive:80,minReviews:100}};wizards.set(id,w);await respond(setupCard(w,id));return;}
        if(checking){await respond('An offer check is already running. Try again after it finishes.');return;}
        const last=manualChecks.get(i.guildId) || 0;if(Date.now()-last<60000){await respond('Wait one minute between manual checks for this server.');return;}
        if(!state.channels[i.guildId] && !Object.keys(state.streams[i.guildId] || {}).length){await respond('No alert streams configured. Run /setup first.');return;}
        manualChecks.set(i.guildId,Date.now());for(const key of sources.cache.keys())if(!key.startsWith('review'))sources.cache.delete(key);
        await checkAlerts(i.guildId);await respond('Check finished for this server. New matching offers were posted where available; quiet hours, digest schedules and duplicate protection still apply. Use /health to inspect source errors.');return;
      }
      if(['schedule','exportsettings','importsettings'].includes(cmd)) {
        if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond('Manage Server permission required.');return;}
        if(cmd==='schedule') {
          const kind=i.options.getString('type',true);state.streams[i.guildId] ??= {};
          if(kind==='game' && !state.streams[i.guildId].game && state.channels[i.guildId])state.streams[i.guildId].game={...state.channels[i.guildId]};
          const c=state.streams[i.guildId][kind];if(!c){await respond('Configure the stream first.');return;}
          const timezone=i.options.getString('timezone') || c.timezone || 'America/Chicago';new Intl.DateTimeFormat('en-US',{timeZone:timezone});c.timezone=timezone;
          for(const [opt,key] of [['quiet_start','quietStart'],['quiet_end','quietEnd'],['digest_hour','digestHour']]){const n=i.options.getInteger(opt);if(n!==null)c[key]=n;}
          const digest=i.options.getBoolean('digest');if(digest!==null)c.digest=digest;save();await respond(`Schedule saved for ${kind} in ${timezone}. Digest: ${!!c.digest}. Quiet: ${c.quietStart ?? 'off'}–${c.quietEnd ?? 'off'}.`);return;
        }
        if(cmd==='exportsettings') {
          const streams=state.streams[i.guildId] || {};const data={format:'freegames-settings-v1',streams:Object.fromEntries(Object.entries(streams).map(([k,c])=>[k,cleanConfig(c)]))};
          if(!data.streams.game && state.channels[i.guildId])data.streams.game=cleanConfig(state.channels[i.guildId]);
          await respond({content:'Server alert configuration only; no tokens, personal profiles or sent-message history.',files:[new AttachmentBuilder(Buffer.from(JSON.stringify(data,null,2)),{name:'freegames-settings.json'})]});return;
        }
        const attachment=i.options.getAttachment('file',true);if(attachment.size>200000)throw new Error('Settings export exceeds 200 KB');
        const response=await fetch(attachment.url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Could not download settings');
        const data=JSON.parse(await response.text());if(data.format!=='freegames-settings-v1' || typeof data.streams!=='object')throw new Error('Invalid export format');
        const imported={};const me=await i.guild.members.fetchMe();
        for(const [kind,input] of Object.entries(data.streams)){if(!['game','loot','weekend','deals'].includes(kind))throw new Error('Invalid stream');const c=cleanConfig(input);const channel=await i.guild.channels.fetch(c.channel);if(!channel || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('Imported channel missing or inaccessible; edit the exported channel IDs for this server.');if(c.role && !i.guild.roles.cache.has(c.role))throw new Error('Imported role not in this server');imported[kind]={...c,seen:[],reminded:[]};}
        state.streams[i.guildId]={...(state.streams[i.guildId] || {}),...imported};save();await respond('Settings imported. Existing other streams retained; imported streams start fresh alert history.');return;
      }
      if(cmd==='history') {
        if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond('Manage Server permission required in this server.');return;}
        const status=i.options.getString('status'),page=i.options.getInteger('page') || 1;
        const entries=(state.history[i.guildId] || []).filter(e=>e.time>=Date.now()-30*86400000 && (!status || e.status===status)).slice().reverse();
        if(i.options.getBoolean('export')){await respond({content:'Retained server notification history (up to 300 entries / 30 days).',files:[new AttachmentBuilder(Buffer.from(JSON.stringify(entries,null,2)),{name:'notification-history.json'})]});return;}
        const rows=entries.slice((page-1)*20,page*20).map(e=>`<t:${Math.floor(e.time/1000)}:R> • **${e.status}** • ${escapeMarkdown(text(e.title,70))}\n${escapeMarkdown(text(e.reason,120))}${e.channel?' • <#'+e.channel+'>':''}`);
        await respond({embeds:[new EmbedBuilder().setTitle(`Notification history • page ${page}`).setDescription(rows.join('\n\n').slice(0,4000) || 'No history matches this page. New events are recorded after updating.').setFooter({text:`${entries.length} retained entries • up to 300 entries / 30 days • server-only audit`})]});return;
      }
      if(cmd==='diagnostics') {
        const app=await client.application.fetch();
        if(i.user.id!==app.owner?.id && (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))){await respond('Diagnostics require the application owner or Manage Server permission.');return;}
        const key='diag:'+(i.guildId || i.user.id),until=cooldown.get(key) || 0;
        if(until>Date.now()){await respond('Wait two minutes between source diagnostics.');return;}
        cooldown.set(key,Date.now()+120000);
        const results=await diagnosticResults(sources,i.options.getString('source') || 'all');
        const rows=results.map(r=>r.ok?`🟢 **${r.source}**: endpoint/parser succeeded • ${r.count} current matching offers • ${(r.elapsed/1000).toFixed(1)}s`:`🔴 **${r.source}**: ${escapeMarkdown(r.error)}\n${r.advice}`);
        await respond({embeds:[new EmbedBuilder().setTitle('Live source diagnostics').setDescription(rows.join('\n\n')).setFooter({text:'Tests configured offer readers; zero matches is valid. This does not verify every game/store claim or Prime/Game Pass catalogs.'})]});return;
      }
      if(cmd==='health') {
        const rows=[...sources.health].filter(([key])=>!key.startsWith('review')).slice(-20).map(([key,h])=>`${h.ok?'🟢':'🔴'} **${key}** — ${h.ok?(h.count===null?'OK':`${h.count} offers`):text(h.error,160)}${h.nextRetry?` • retry <t:${Math.floor(h.nextRetry/1000)}:R>`:''}${h.recoveredAt?' • recovered':''} • <t:${Math.floor(h.time/1000)}:R>`);
        await respond({embeds:[new EmbedBuilder().setTitle('Offer source health').setDescription(rows.join('\n') || 'No source checks yet. Run /free to load sources.').setFooter({text:'Recent fetches only; cached results are not a fresh connectivity test.'})]});return;
      }
      if(cmd==='updates') {
        const action=i.options.getString('action') || 'status';
        if(action!=='status') {
          const app=await client.application.fetch();
          if(i.user.id!==app.owner?.id){await respond('Only the Discord application owner can request an update or rollback.');return;}
          if(!process.send){await respond('Start the bot with Start-Bot.bat or npm start to enable supervisor controls.');return;}
          await respond(action==='rollback'?'Rollback requested. Program files will restore from the latest backup; the bot restarts and local config/state remain intact.':'Update check requested. The bot may restart if a new release is available.');
          process.send({type:action==='rollback'?'rollback':'update-check'});return;
        }
        const pkg=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8'));
        let status={};try{status=JSON.parse(readFileSync(join(ROOT,'.update-status.json'),'utf8'));}catch{}
        let marker={};try{marker=JSON.parse(readFileSync(join(ROOT,'.update-version.json'),'utf8'));}catch{}
        await respond({components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('updates:check').setLabel('Check Updates').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('updates:rollback').setLabel('Restore Backup').setStyle(ButtonStyle.Danger).setDisabled(!marker.backup))],embeds:[new EmbedBuilder().setTitle('Live update status').setDescription(`Installed: **${pkg.version}**\nLatest observed: ${status.latest || 'Not checked'}\nLast check: ${status.checkedAt || 'Not checked'}\nResult: ${status.error || status.result || 'Unknown'}\nBackup: ${marker.backup?'Available':'None recorded'}\nSupervisor: ${process.send?'Connected':'Not running'}\nUse /updates action:check or rollback (application owner only).`)]});return;
      }

      if(cmd==='prime' || cmd==='gamepass'){await respond(subscriptionCard(cmd));return;}
      if(cmd==='notificationsettings') {
        if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond('Manage Server permission required.');return;}
        const selected=i.options.getString('type');
        const kind=selected || 'game';
        state.streams[i.guildId] ??= {};
        if(!state.streams[i.guildId][kind] && kind==='game' && state.channels[i.guildId])state.streams[i.guildId][kind]={...state.channels[i.guildId],reminded:[]};
        if(!selected){save();await respond(notificationHome(state.streams[i.guildId],i.guildId));return;}
        const c=state.streams[i.guildId][kind];if(!c){await respond('First use /configure type:'+kind+' channel:#your-channel.');return;}
        save();await respond(notificationPanel(c,i.guildId,kind));return;
      }
      if(cmd==='settings'){
        const scope=i.options.getString('scope');
        if(scope==='server' || (!scope && i.inGuild() && i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
          if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond('Server settings require Manage Server permission in a server.');return;}
          state.streams[i.guildId] ??= {};
          if(!state.streams[i.guildId].game && state.channels[i.guildId])state.streams[i.guildId].game={...state.channels[i.guildId],reminded:[]};
          save();await respond(notificationHome(state.streams[i.guildId],i.guildId));
        }else await respond(settingsCard(personal,i.user.id));
        return;
      }
      if(cmd==='preferences') {
        const words=i.options.getString('keywords',true);personal.keywords=words.toLowerCase()==='all'?[]:words.split(',').map(s=>s.trim()).filter(Boolean).slice(0,10);save();
        await respond({content:'Preferences updated. Genre/keyword matches use titles and descriptions, not verified genre metadata.',flags:MessageFlags.Ephemeral});return;
      }
      if(cmd==='claimed') {
        if(i.options.getString('action')==='clear'){personal.claimed=[];save();}
        await respond({content:`${(personal.claimed || []).length} offers marked claimed. Tracking is manual, not verified against your store account. Use /claimed action:clear to reset.`,flags:MessageFlags.Ephemeral});return;
      }
      if(cmd==='wishlist') {
        const action=i.options.getString('action',true),name=i.options.getString('name')?.trim();personal.wishlist ??= [];
        if(action!=='list' && !name){await respond({content:'Provide the game name.',flags:MessageFlags.Ephemeral});return;}
        if(action==='add' && !personal.wishlist.some(n=>n.toLowerCase()===name.toLowerCase())) {
          if(personal.wishlist.length>=10){await respond({content:'Limit: 10 watched game names per user.',flags:MessageFlags.Ephemeral});return;}
          personal.wishlist.push(name);
        }
        if(action==='remove')personal.wishlist=personal.wishlist.filter(n=>n.toLowerCase()!==name.toLowerCase());
        save();await respond({content:`Watched games: ${personal.wishlist.join(', ') || 'None'}\nEnable wishlist DMs in /settings. Free matches cover supported stores; discount matches use Steam.`,flags:MessageFlags.Ephemeral});return;
      }
      if(cmd==='configure') {
        if(!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await respond({content:'Manage Server permission required.',flags:MessageFlags.Ephemeral});return;}

        const kind=i.options.getString('type',true);state.streams[i.guildId] ??= {};
        if(i.options.getBoolean('enabled')===false){delete state.streams[i.guildId][kind];if(kind==='game')delete state.channels[i.guildId];save();await i.editReply('Stream disabled.');return;}
        const channel=i.options.getChannel('channel');
        if(!channel){await i.editReply('Choose a destination channel.');return;}
        const me=await i.guild.members.fetchMe();
        if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks])){await i.editReply('Missing channel permissions: View Channel, Send Messages or Embed Links.');return;}
        state.streams[i.guildId][kind]={channel:channel.id,platform:i.options.getString('store') || 'all',seen:[],reminded:[],
          minDiscount:i.options.getInteger('min_discount') || 30,minPositive:i.options.getInteger('min_positive') || 80,minReviews:i.options.getInteger('min_reviews') || 100,reminderHours:i.options.getInteger('reminder_hours') || 6};
        save();await i.editReply(`${kind} alerts configured in <#${channel.id}>. Checks every 30 minutes; current offers post on the next check.`);return;
      }
      if (['alerts', 'stopalerts'].includes(cmd)) {
        if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await respond({ content: 'You need Manage Server permission.', flags: MessageFlags.Ephemeral }); return;
        }
        if (cmd === 'stopalerts') { delete state.channels[i.guildId]; delete state.streams[i.guildId]; save(); await respond({ content: 'Automatic alerts disabled.', flags: MessageFlags.Ephemeral }); return; }

        const channel = i.options.getChannel('channel', true), store = i.options.getString('store') || 'all';
        const me = await i.guild.members.fetchMe();
        if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          await i.editReply('Give me View Channel, Send Messages and Embed Links there first.'); return;
        }
        if(state.streams[i.guildId])delete state.streams[i.guildId].game;
        state.channels[i.guildId] = { channel: channel.id, platform: store, seen: [] }; save();
        await i.editReply(`${PLATFORMS[store]} alerts enabled in <#${channel.id}>. Normally paid games offered free post on the next 30-minute check.`); return;
      }
      if (cmd === 'stores') {
        await respond({ content: 'Giveaway filters:\n' + Object.values(PLATFORMS).map(n => `• ${n}`).join('\n') + '\n/free lists normally paid games offered free across these stores. /deals uses Steam only. PlayStation offers are excluded.', flags: MessageFlags.Ephemeral }); return;
      }
      const page = i.options.getInteger('page') || 1, search = i.options.getString('search') || '';
      if (cmd === 'deals') {
        const remaining = (cooldown.get(i.user.id) || 0) - Date.now();
        if (remaining > 0) { await respond({ content: `Wait ${Math.ceil(remaining / 1000)} seconds before checking deals again.`, flags: MessageFlags.Ephemeral }); return; }
        cooldown.set(i.user.id, Date.now() + 30000);
      }

      if (cmd === 'giveaways' || cmd === 'free') {
        for (const [id, session] of sessions) if (Date.now() - session.created > 24 * 60 * 60 * 1000) sessions.delete(id);
        const id = randomUUID();
        const session = {user:i.user.id, store:i.options.getString('store') || 'all',kind:'game',index:page-1,search,created:Date.now()};
        sessions.set(id,session);
        await i.editReply(await browse(session,id));
      } else if (cmd === 'deals') {
        const discount = i.options.getInteger('min_discount') || personal.minDiscount || 30, positive = i.options.getInteger('min_positive') || personal.minPositive || 80, reviews = i.options.getInteger('min_reviews') || personal.minReviews || 100;
        const result = await sources.deals(page, search, discount, positive, reviews);
        let description = result.games.slice(0,10).map(g => `**[${escapeMarkdown(text(g.title,130))}](${g.url})**\n${g.price} (was ${g.original}) • **${g.discount}% off**\n${g.positive.toFixed(1)}% positive • ${g.reviews.toLocaleString()} reviews`).join('\n\n') || 'No matches on this sale page. Try the next page or lower your thresholds.';
        if (result.failures) description += `\n\nReview checks unavailable for ${result.failures} candidates; omitted.`;
        const embed = new EmbedBuilder().setTitle(`Good Steam deals • page ${page}`).setColor(0xF1C40F).setDescription(description.slice(0,4000))
          .setFooter({ text: `${discount}%+ off • ${positive}%+ positive • ${reviews}+ reviews • ${result.total.toLocaleString()} sale matches before filtering • regional prices` });
        const list = result.games.map(g => `${g.title} | ${g.price} (was ${g.original}) | ${g.discount}% off | ${g.positive.toFixed(1)}% positive (${g.reviews} reviews) | ${g.url}`).join('\n') || 'No matches.';
        await i.editReply({ embeds: [embed], components: steamRows(result.games,10), files: [new AttachmentBuilder(Buffer.from(list), { name: `steam-deals-page-${page}.txt` })] });
      } else { await i.editReply('Unknown command. Restart to register current commands.'); }
    } catch (error) {
      log(`Command ${i.commandName} failed: ${error.name}`);
      const content = 'Command failed. Check bot.log and try again. A source may be temporarily unavailable.';
      try { if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [] }); else await respond({ content, flags: MessageFlags.Ephemeral }); } catch { /* Interaction may have expired. */ }
    }
  });
  client.once(Events.ClientReady, async ready => {
    try {
      const rest = new REST({ version: '10' }).setToken(token), guildId = process.env.DISCORD_GUILD_ID?.trim();
      // User-installed commands must be registered globally, even with a test guild.
      await rest.put(Routes.applicationCommands(ready.user.id), { body: commandDefinitions() });
      if(guildId) {
        if(!ready.guilds.cache.has(guildId)) log('Configured server ID is not a server this bot joined. Global group-DM commands still registered.');
        else {
          const guildCommands=commandDefinitions().map(({contexts,integration_types,...command})=>command);
          await rest.put(Routes.applicationGuildCommands(ready.user.id,guildId),{body:guildCommands});
        }
      }
      const installLink=`https://discord.com/oauth2/authorize?client_id=${ready.user.id}&integration_type=1&scope=applications.commands`;
      writeFileSync(join(ROOT,'Account-Install-Link.txt'),installLink+'\n');
      log(`Ready as ${ready.user.tag}; global account-install commands registered. Install to your account: ${installLink}`);
      await checkAlerts();
      if (!stopping) alertTimer = setInterval(() => void checkAlerts(), 30 * 60 * 1000);
    } catch (error) { log(`Startup failed: ${error.name}${error.code ? ' code '+error.code : ''}: ${error.code===50001 ? 'Missing access. Check DISCORD_GUILD_ID and invite with bot + applications.commands. No Administrator permission needed.' : error.code===50035 ? 'Invalid registration settings. Enable User Install AND Guild Install under Developer Portal > Installation, then restart. See the setup guide.' : error.code===50013 ? 'Missing Discord permissions; check the bot role and channel permissions.' : error.message}`); client.destroy(); process.exitCode = 1; }
  });
  client.on(Events.Error, error => log(`Discord error: ${error.name}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; clearInterval(alertTimer);sources.close(); client.destroy(); });
  await client.login(token);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.name === 'Error' ? error.message : `Startup failed: ${error.name}`); process.exitCode = 1; });
}
