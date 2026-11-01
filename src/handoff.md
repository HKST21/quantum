# HANDOFF — Quantum CRM: volání přes vlastní ústřednu (Asterisk + Odorik + Gemini Live)

**Poslední aktualizace: 1. 11. 2026.** Tento dokument je určený hlavně pro **další Claude (Code) session** a pro člověka,
který přebírá projekt. Přečti ho celý, než na cokoli sáhneš. Je psaný tak, aby šlo začít pracovat bez dalšího vysvětlování.

> **Jedna věta:** Hejdovo UI dál běží na tomto backendu (`quantum-be` na Renderu), ale **hovory už nevolá Twilio**.
> Volá je vlastní ústředna (Asterisk 20 na Hetzneru) přes SIP u Odoriku, s hlasovým agentem Eva běžícím na **Gemini Live**.
> Kód Twilia a OpenAI v tomto repu **zůstává** (nesmí se mazat), ale **v produkci se nepoužívá** — slouží jako záloha a jako
> referenční ukázka migrace pro jiný projekt.

---

## 0. Obsah

1. [Stav v kostce](#1-stav-v-kostce)
2. [Mapa systému](#2-mapa-systému-dva-repozitáře-jedna-databáze)
3. [Co se skutečně používá a co je pozůstatek](#3-co-se-skutečně-používá-a-co-je-pozůstatek)
4. [Jeden hovor krok za krokem](#4-jeden-hovor-krok-za-krokem)
5. [Odorik, SIP jména a maskování čísla (CLIP)](#5-odorik-sip-jména-a-maskování-čísla-clip)
6. [Asterisk a server (Hetzner)](#6-asterisk-a-server-hetzner)
7. [Agenti (Eva) a jejich redukce](#7-agenti-eva-a-jejich-redukce)
8. [Gemini Live: nastavení a chování](#8-gemini-live-nastavení-a-chování)
9. [Konec hovoru: ochrana proti opakování věty](#9-konec-hovoru-ochrana-proti-opakování-věty)
10. [Výsledky hovorů a stavy leadů](#10-výsledky-hovorů-a-stavy-leadů)
11. [Databáze](#11-databáze)
12. [Fronta úkolů (batch_jobs) a spouštění z UI](#12-fronta-úkolů-batch_jobs-a-spouštění-z-ui)
13. [Nahrávky hovorů pro klienta](#13-nahrávky-hovorů-pro-klienta)
14. [Rate limiting a přihlášení (pozor na pasti)](#14-rate-limiting-a-přihlášení-pozor-na-pasti)
15. [ENV proměnné (obě části)](#15-env-proměnné-obě-části)
16. [Provoz: deploy, logy, testování](#16-provoz-deploy-logy-testování)
17. [Diagnostika: co znamenají řádky v logu a co dělat](#17-diagnostika-co-znamenají-řádky-v-logu-a-co-dělat)
18. [Známé problémy a otevřené body (roadmap)](#18-známé-problémy-a-otevřené-body-roadmap)
19. [Pravidla spolupráce se zadavatelem](#19-pravidla-spolupráce-se-zadavatelem)
20. [Příloha A — původní řešení Twilio + Odorik BYOC (archiv)](#příloha-a--původní-řešení-twilio--odorik-byoc-archiv)

---

## 1. Stav v kostce

| Oblast | Stav |
|---|---|
| Provider **„Asterisk + Odorik“** v Hejdově UI | **Hotovo a ověřeno** (start, stop, stav, historie, statistiky) |
| Hovor: vytočení, AI konverzace (Gemini Live), zápis výsledku do DB | **Hotovo a ověřeno** (testy na vlastní číslo) |
| Nahrávky pro klienta (1 stereo MP3, odkaz u leadu, mazání po 14 dnech) | **Hotovo a ověřeno** (přehrání v prohlížeči i z UI) |
| Konec hovoru bez opakování poslední věty | **Nasazeno, 4 testy v pořádku**; čeká na sledování v ostrém provozu (§9) |
| Sériový režim (rotace identit, jeden hovor najednou) | Hotovo |
| **Paralelní režim** (Hejda plánuje ~3 souběžné hovory) | **TODO** |
| Kvalita přepisu řeči zákazníka, odstranění zbytečného převodu zvuku | **TODO** (hned po nahrávkách; slíbeno zadavateli) |
| Nové stavy (neexistující číslo, vypnutý telefon, hlasová schránka) | **TODO** (nejdřív sledovat surová data z Odoriku) |
| Facebook agenti přes Asterisk | **TODO** (UI je teď pro provider Asterisk skrývá) |
| Redukce agentů na 4 (§7) | **Rozhodnuto, v kódu ještě neprovedeno** |
| Odpojení Twilia | **Až na konec** |
| Watchdog „hovor nikdy > 90 s“ | **Úplně na konec** (jednou způsobil ticho v úvodu hovoru, příčina nenalezena) |

**Co z toho plyne pro tebe:** když Štěpán napíše „spustil jsem hovor“ nebo „nezvoní to“, jde téměř vždy o ústřednu na Hetzneru
(služba `ustredna-worker`) a Odorik, **ne** o Render. Render jen zapíše úkol do DB a zobrazuje stav.

---

## 2. Mapa systému (dva repozitáře, jedna databáze)

```
 Hejdovo UI (React, frontend/ v quantum-be)
        │  POST /api/ai-calls/start  { provider: 'asterisk', engine: 'gemini', agentUserId, … }
        ▼
 quantum-be  (Render, repo HKST21/quantum, lokálně C:\dev\weby\quantum-be, URL https://quantum-1way.onrender.com)
   • CRM, uživatelé, leady, import, statistiky, historie dávek
   • u provideru 'asterisk' jen ZAPÍŠE ŘÁDEK do tabulky batch_jobs (fronta) a odpoví
   • přehrává nahrávky:  GET /api/recordings/<token>.mp3   (veřejné, chráněné náhodným tokenem)
        │
        ▼
 PostgreSQL (Render, databáze quantum_db_lh1i, SDÍLENÁ oběma částmi)
   leads, ai_call_logs, lead_comments, users, batch_jobs, call_recordings, alerts, …
        ▲                                   ▲
        │ čte batch_jobs (poll 3 s)         │ zapisuje výsledky + nahrávky
        │                                   │
 ustredna-quantum  (Hetzner VPS, repo HKST21/ustredna-quantum, lokálně C:\dev\ustredna-quantum)
   • systemd služba `ustredna-worker`  (Node/TypeScript)
   • Asterisk 20 (PJSIP) ←SIP→ sip.odorik.cz ──► zákazník
   • ARI 127.0.0.1:8088 (vytáčení, stavy)  •  AudioSocket 127.0.0.1:9092 (zvuk PCM16 8 kHz)
   • Gemini Live (WebSocket) = hlas a konverzace Evy
```

**Zásadní pravidla architektury (neporušovat):**

- **Hetzner je uzavřený** — žádný veřejný vstupní port ani HTTPS endpoint (kromě SSH s fail2ban). Vše mezi Renderem a Hetznerem
  jde přes **sdílenou databázi** (fronta `batch_jobs`, výsledky v `ai_call_logs`, nahrávky v `call_recordings`).
- `quantum-be` zůstává **CRM + backend + (nezměněná) cesta přes Twilio jako záloha**. Ústředna je samostatný projekt, který zapisuje do stejné DB.
- Pro Hetzner existuje **omezená DB role `voice_bridge`** (jen potřebná oprávnění; viz §11).
- **Žádné nové placené služby pro klienta** (proto nahrávky v DB, ne v S3/R2).

**Dokumentace druhé strany (autoritativní pro ústřednu):** v repu `ustredna-quantum`:
`docs/MIGRACE_TWILIO_NA_ASTERISK.md` (průvodce migrací včetně srovnání soubor po souboru), `db/schema-snapshot.md` (aktuální struktura DB),
`db/migrations/*.sql` (jediné místo pro SQL změny). **Tento handoff je přehled pro celek; detaily ústředny jsou tam.**

---

## 3. Co se skutečně používá a co je pozůstatek

### 3.1 Produkční cesta (používá se)

| Vrstva | Soubor / část | Role |
|---|---|---|
| UI | `frontend/src/pages/Calling.tsx` — tlačítko provideru „🛰 Asterisk + Odorik“, Stop | Spuštění/zastavení dávky |
| UI | `frontend/src/api/index.ts` — `startAICalling`, `stopAICalling`, `CallProvider` | Volání API |
| Backend | `src/aiagent/controllers/aiCalls.controller.ts` — větev `provider === 'asterisk'` | Zapíše úkol do `batch_jobs`; `stopAICalling` nastaví `stop_requested` |
| Backend | `src/aiagent/controllers/batchCalls.controller.ts` — `getBatchStatus` (`isRunning` včetně aktivního úkolu), historie, statistiky | Stav pro UI |
| Backend | `src/aiagent/controllers/recordings.controller.ts` + `routes/recordings.routes.ts` | Přehrávání nahrávek |
| Backend | `src/routes/index.ts` — `/recordings` mimo `/ai-calls` (tam je `authenticate` na celém routeru) | Veřejná cesta pro přehrávač |
| Backend | `src/server.ts` — rate limiter, helmet | Viz §14 |
| Ústředna | celé repo `ustredna-quantum` | Skutečné volání |

### 3.2 Pozůstatky Twilia a OpenAI (zůstávají v kódu, **nepoužívají se**)

> **Nemazat při „úklidu“.** Zadavatel je výslovně chce zachovat: (a) jako zálohu, (b) jako **referenci pro jiný projekt**,
> aby bylo vidět, jak kód vypadal před migrací a po ní. Jakékoli mazání se dělá jen na výslovný pokyn Štěpána.

| Pozůstatek | Kde | Popis |
|---|---|---|
| Twilio hovory | `src/aiagent/services/twilioService.ts`, `callOrchestrator.ts` (osy provider × engine × linka × mód) | `client.calls.create` + statusCallback, smyčka `processLead` běžící v procesu Renderu |
| Twilio Media Streams | `src/aiagent/websockets/geminiCallHandler.ts` (Gemini) a `callHandler.ts` (OpenAI Realtime), zaregistrované v `src/server.ts` na WebSocketu `/api/ai-calls/websocket` | Zvuk z Twilia ↔ Gemini/OpenAI. Jejich „přeložená“ verze pro Asterisk je `asteriskCallHandler.ts` v ústředně |
| Twilio číslo / pracovní čísla | `getTwilioNumber` (endpoint), `TWILIO_WORKER_PHONES` v `Calling.tsx` (5 čísel), env `TWILIO_*` | Odchozí čísla Twilia |
| Odorik přes Twilio BYOC | `src/aiagent/services/odorikService.ts` (verze v quantum-be), provider `'odorik'` v UI | Twilio → BYOC trunk → Odorik (viz Příloha A) |
| OpenAI engine | `engine: 'openai'`, prompty a služby OpenAI, agenti označení „OpenAI“ | Alternativa ke Gemini |
| Providery v UI | tlačítka „Twilio“ a „Odorik“ vedle „Asterisk + Odorik“ | Záloha |

**Praktické pravidlo pro změny:** nové funkce se dělají **jen v cestě Asterisk** (ústředna + `batch_jobs` + `provider: 'asterisk'`).
Starou cestu neopravuj ani nerozšiřuj, pokud o to Štěpán nepožádá. Je zmrazená.

### 3.3 Odpojení Twilia (plán, zatím neprovedeno)

Až budou hotové: paralelní režim, nové stavy, FB agenti přes Asterisk a až po ostrém ověření. Pak se Twilio **odpojí** (zrušení
účtu/čísel, odebrání tlačítek z UI nebo jejich zneviditelnění), **kód se ale ponechá** jako archiv. Postup domluvit se Štěpánem.

---

## 4. Jeden hovor krok za krokem

1. **UI:** Hejda vybere agenta, provider „Asterisk + Odorik“ (engine se vynutí Gemini), počet hovorů, spustí.
2. **Backend (Render):** `startAICalling` ověří vstupy, vybere leady (`status='NOVY'`, `assigned_to=agent`, `ai_call_status IS NULL` nebo `'failed'`),
   odmítne start, pokud existuje jiný úkol `pending/running`, a **zapíše řádek do `batch_jobs`**. Hned odpoví 200 s `jobId`.
3. **Worker (Hetzner, `jobWorker.ts`):** každé 3 s hledá úkol, atomicky ho převezme (`FOR UPDATE SKIP LOCKED`), vybere **skupinu linek** podle agenta
   (V1/V2/V5 → `pool`; FB V6–V9 → `fb`) a pro každý lead spustí `callOrchestrator.processLead`.
4. **Pro každý lead (`processLead`):**
    1. `loadLead`, `markCalling` (`ai_call_status='calling'`, `ai_last_call_at`, `ai_call_attempts+1`).
    2. **Odorik REST:** `deleteAllRoutes(sipJméno)` → `setForward(sipJméno, číslo leadu)` ve formátu `*087` + `00420…`. Pak **pauza 1,5 s** na propagaci.
    3. Kontrola, že identita má CLIP (`fromNumber`).
    4. `insertCallLog` (řádek v `ai_call_logs` se stavem `calling`, `telephony='asterisk'`).
    5. **Vytočení:** ARI `originate` na `PJSIP/<sipJméno>@odorik` s `callerId = CLIP identity`. Zároveň se **předehřeje (prewarm) Gemini** (WS + setup během vyzvánění).
    6. **Zvednuto** (ARI `StasisStart`): kanál se přesměruje do dialplánu `[ai]` → `AudioSocket(CALL_UUID, 127.0.0.1:9092)`.
    7. `asteriskCallHandler.ts` pošle zvuk do Gemini a výstup Gemini zpět. Eva řekne úvod; zákazník odpoví; Eva se rozloučí a zavolá funkci `end_call_with_outcome`.
    8. `callResultWriter.writeResult`: stav leadu, `ai_call_logs` (výsledek, délka, přepis, poznámky), `lead_comments`.
    9. Nahrávka (jen `interested`) — viz §13.
    10. `finally`: **pauza 10–18 s** před dalším hovorem (rozložení proti označení za spam).
5. Po posledním leadu: úkol `completed`. Stop z UI: `stop_requested` se kontroluje **před každým leadem**; běžící hovor doběhne, další se nevytočí.

Časování (převzato z Twilia, neměnit bez důvodu): ring timeout **50 s**; limit hovoru **120 s** od připojení AudioSocketu;
čekání na hovor max **90 s** (po něm `no_answer` „Call timeout“); záložní timeout po výsledku **10 s**; pevný konec po výsledku
**10 s + zbytek fronty**; graceful konec **4 s** po výsledku/posledním audiu; posmrtka (požadavek na výsledek po zavěšení zákazníka) **5 s**.

---

## 5. Odorik, SIP jména a maskování čísla (CLIP)

### 5.1 Proč to takto

Cíl: zákazník vidí **české číslo** (ne zahraniční, ne číslo serveru), a čísla se **střídají**, aby je operátoři a aplikace nezablokovaly jako spam
(zhoršující se úspěšnost zvednutí u původní mobilní linky byla důvod, proč vznikly další linky). Zároveň musí být volání **levné**
(Twilio na české mobily je řádově dražší než Odorik).

### 5.2 Pojmy

| Pojem | Význam |
|---|---|
| **Linka (Odorik)** | Účet/podlinka u Odoriku, každá má své **číslo v síti** a **veřejné číslo = CLIP** (číslo, které uvidí volaný). |
| **SIP jméno** | Doplňkový záznam „veřejné číslo“ na lince (např. `hejda_pool1`). Dá se na něj volat jako `sip:JMENO@sip.odorik.cz`. Vytváří se v administraci Odoriku („průvodce nastavením“ → Vlastní telefonní číslo → SIP jména). Bez diakritiky, oddělovač `_` nebo `.`. |
| **Public Numbers API** | REST rozhraní Odoriku (`https://www.odorik.cz/api/v1/public_numbers/<SIP jméno>/routes.json`). Určuje, **kam se hovor na SIP jméno přesměruje**. |
| **Route / přesměrování** | Záznam „zavolej na X“. Před **každým** hovorem se smaže a nastaví znovu na číslo aktuálního leadu. |
| **`*087`** | Předpona v cílovém čísle (`ringing_number`), se kterou Odorik odešle hovor s **CLIP dané linky**. Fungují varianty `*08700420XXXXXXXXX` (používáme) a `*087XXXXXXXXX`; **bez `+`** (varianta s `+` nedoporučena). Přesný vnitřní význam předpony Odorik nerozepisuje — vlastnost je ověřená empiricky. |
| **Identita** | Dvojice **SIP jméno + CLIP**. Rotace střídá identity mezi leady. |
| **Skupina linek** | `pool` (agenti V1/V2/V5) nebo `fb` (agenti Facebook). Každá skupina má svoje identity v `.env` ústředny. |

### 5.3 Jak maskování funguje (tok)

```
ústředna (Asterisk, Hetzner)                                    Odorik                         zákazník
  1) REST: smaž staré routes na SIP jméně  ───────────────────►  (public_numbers/<jméno>)
  2) REST: route  source_number=*  ringing_number=*08700420XXXXXXXXX
  3) čekej 1,5 s (propagace)
  4) SIP INVITE na  sip:<jméno>@sip.odorik.cz  (From/CallerID = CLIP identity)  ──►  najde route,
                                                                                    zavolá na cílové číslo
                                                                                    s CLIP linky  ─────────► uvidí český CLIP
```

- **Asterisk nevolá zákazníka přímo.** Volá vždy stejnou adresu u Odoriku; *kam to půjde* určuje REST route nastavená těsně předtím.
- **Bez registrace, bez hesla, bez IP whitelistu.** SIP jméno je veřejné číslo; Odorik potvrdil, že hovory z libovolné IP přijme.
  Autentizace se tedy neřeší na SIP úrovni (v `pjsip.conf` jsou jen codec/RTP/NAT nastavení).
- ARI `originate` předává `callerId = fromNumber` identity. Zákazníkovi se má zobrazit CLIP odpovídající identitě; **při zavedení každé nové identity
  to ověř na vlastním telefonu** (zavolat na vlastní číslo a podívat se, co displej ukazuje). Neměj za to, že je to automaticky správně.
- Po hovoru se route zbytečně nemaže; maže se **před dalším hovorem na stejném SIP jménu** (§5.5, poučka 2).

### 5.4 Identity v `.env` ústředny (formát)

Číslovaně od 1, **bez mezer** (čtení končí na první chybějící):

```
ODORIK_POOL_SIP_NAME_1=hejda_pool1      ODORIK_POOL_CLIP_1=+420222765487
ODORIK_POOL_SIP_NAME_2=…                 ODORIK_POOL_CLIP_2=…
… _3, _4, _5          (aktuálně 5 identit ve skupině pool = 5 identit v rotaci)

ODORIK_FB_SIP_NAME_1=…                   ODORIK_FB_CLIP_1=…
… až _7               (skupina fb, 7 linek pro FB agenty)
```

Skutečné hodnoty jsou jen v `.env` na serveru (`grep ODORIK_ ~/ustredna-quantum/.env`; hesla `ODORIK_API_*` nikam neposílej).
Identita s jen jednou polovinou (jen jméno nebo jen CLIP) se **přeskočí** s varováním v logu.

Starší, na Twilio navázané linky (zachované v pozůstatku, používají se jen přes provider „Odorik“ s Twiliem):
mobilní **790766** (CLIP **703614594**, SIP jména `hejda_test1`, `hejda_test2`), pevná pražská **793305** (CLIP **217217749**, SIP jméno `hejda_pevna1`).

### 5.5 Kritická pravidla pro REST API Odoriku (zaplaceno chybami)

1. **Žádný HTTP Basic Auth.** `user` a `password` se posílají jako query/form parametry. Basic Auth vede k tichému selhání (200 OK, route se neuloží).
2. **Vždy smazat staré routes před nastavením nových** (`deleteAllRoutes` → `setForward`). Jinak zůstane starý cíl a hovor jde na špatné číslo.
3. **Odorik vrací věcné chyby s HTTP 200.** Např. `{"errors":["nonexisting_public_number"]}`. Kód musí číst `response.data.errors`, ne jen status.
   (Opraveno v `odorikService.ts`; při ladění „API hlásí úspěch, ale nezvoní“ vždy zkontroluj **surové tělo** odpovědi.)
4. **Holé číslo linky není routovatelné přes Public Numbers API.** Musí pro něj existovat SIP jméno.
5. **Jedno SIP jméno = jeden souběžný hovor.** Dva hovory na stejném jménu by si přepsaly přesměrování. Souběžnost = počet SIP jmen.
6. Formát cílového čísla: vstup `+420703034160` / `00420703034160` / `703034160` se normalizuje na `00420XXXXXXXXX`, před něj `*087`.
7. Odorik posílá jen **183 Session Progress**, nikdy 180 Ringing → „zvonění“ se odhaduje (kanál žije ≥ 4 s nebo hned po úspěšném `originate`) a podle toho se rozjíždí prewarm Gemini.
8. Sporadicky se stane, že hovor na straně Odoriku **nezvoní** (v logu `Nezvednuto: no-answer (ringing=false, alive=50018 ms, cause=0)`).
   Jednou se to stalo 1. 11. 2026 a opakování o minutu později prošlo. Nebyla to chyba kódu. Pokud se bude opakovat, vyžádat si u Odoriku logy a zkoumat.
   Pozor na rozlišení: **`cause=0` + `ringing=false` + 50 s** = Odorik nic nevrátil; **`cause=17`** = obsazeno.

### 5.6 Zřízení nové linky nebo SIP jména (postup)

1. V administraci Odoriku zjistit číslo linky a její veřejné číslo (CLIP).
2. Vytvořit SIP jméno (samoobslužně, viz §5.2). Ověřeno: funguje v API okamžitě; schvalování u T-Mobile se u samoobslužně zřízených jmen neprojevilo, ale nelze to vyloučit — vždy živě otestovat.
3. Zkusit `setForward` (musí vrátit validní `id` a **žádné** `errors`).
4. Přidat identitu do `.env` na serveru (`…_SIP_NAME_n` + `…_CLIP_n`), restart `./deploy.sh`.
5. Zkušební hovor **na vlastní číslo**; ověřit, který CLIP se zobrazí.

---

## 6. Asterisk a server (Hetzner)

- **Server:** Hetzner VPS, Ubuntu 24.04, **1 vCPU, 2 GB RAM, 40 GB disk**, 20 TB provozu. Adresa 188.245.27.163, uživatel `stepan`, přihlášení heslem přes SSH
  (záměr zadavatele). Hardening: root login vypnutý, `ufw`, `fail2ban`. **Žádné veřejné příchozí porty** kromě SSH.
- **Asterisk 20.6.0** s vestavěným modulem **AudioSocket**. Konfigurace v repu `asterisk/` (`pjsip.conf`, `extensions.conf`, `rtp.conf`, `deploy-asterisk.sh`).
  `ari.conf` a `http.conf` (heslo ARI) **nejsou v repu**, jen na serveru. ARI: `127.0.0.1:8088`, uživatel `nodeapp`, aplikace `voicebridge`.
- **`pjsip.conf`:** jeden odchozí endpoint `odorik` → `sip:sip.odorik.cz`, kodeky `ulaw`/`alaw`, `direct_media=no`, `rtp_symmetric=yes`, `force_rport=yes`, příchozí kontext blokuje.
- **`extensions.conf`:** kontext `[ai]` (`s` → `AudioSocket(${CALL_UUID},127.0.0.1:9092)` → `Hangup`) pro ostré hovory; `[test]` s extensiony pro interní testy
  (echo `102`, AudioSocket `200`, simulace obsazeno `310`, nezvedl `311`, selhání `312`, zákazník `301/302/313/314`); `[odorik-inbound-blocked]`.
  V ostrém `[ai]` **není** `TIMEOUT(absolute)` (limit se řeší v kódu).
- **Služba:** systemd jednotka `ustredna-worker` (`Restart=on-failure`, `TimeoutStopSec=180`), pracovní složka `~/ustredna-quantum`.
- **Port 9092 drží služba** — před ručními testy (`runBatch.ts`, `testAiCall.ts`) `sudo systemctl stop ustredna-worker`, po nich `start`.
- **Restart služby zabije rozběhnutý hovor.** `./deploy.sh` proto při běžícím úkolu restart odmítne (`--force` to obejde).
- **Shell pozor:** SSH/SCP spouštět v **druhém okně** PowerShellu na PC; příkazy pro server ve spojeném okně. V `nano` se ukončuje **Ctrl+X** jako zkratka — nepsat ho jako text (už jednou skončilo `^X` v `.env`).

---

## 7. Agenti (Eva) a jejich redukce

### 7.1 Rozhodnutí z 1. 11. 2026 (Hejda)

Ponechat **pouze** tyto čtyři agenty:

| Agent | UUID (`users.id`) | Engine | Poznámka |
|---|---|---|---|
| **Eva V1** | `53c65ca7-68bc-4948-83e5-35a64c17f0fb` | OpenAI + Gemini | skupina linek `pool` |
| **Eva Gemini V2** | `dab796fa-bf16-4f99-812c-601a031049ce` | jen Gemini | **hlavní, výchozí**; skupina `pool` |
| **Eva V5** | `ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9` | OpenAI + Gemini | skupina `pool` |
| **Eva FB V9** | `3aa4d37f-ebd7-49f9-a72f-c04ac33c057d` | jen Gemini | FB leady; skupina `fb` |

Všichni ostatní se **odstraní z kódu** (viz 7.3). Dosud (stav kódu) jsou ještě přítomni:
Eva V2 `aeec78ff-a86b-4cab-b33a-adeb7c94f08e`, Eva V3 `e7a469bb-4783-4f96-b961-03dd503e5bfa`, Eva V4 `f4adb349-70c3-4e63-8670-81f6c177f61d` (všechny OpenAI);
Eva FB V6 `99142508-1483-4ea2-ba9f-c35a9ecdc69f`, V7 `773db522-8df4-4903-9b4f-019b8b0969b5`, V8 `a2a7c4f6-1b90-4b64-8899-451dca563c96` (Gemini FB).

> **Požadavek zadavatele na zbylé agenty:** musí jít spouštět **přes Asterisk** (hlavní cesta) **i přes Twilio / Odorik + Twilio** (záloha).
> FB V9 dnes přes Asterisk ještě nejde (UI FB agenty při provideru Asterisk skrývá; skupina `fb` ve workeru existuje) — viz §18.

### 7.2 Jak se agent pozná a kde je definován

- Agent = řádek v `users` (UUID výše; v UI se vybírá a leady mu patří přes `leads.assigned_to`).
- **UI seznam:** pole `AGENTS` v `frontend/src/pages/Calling.tsx` (jméno, popis, úvodní věta, závěr, povolené enginy, příznak `isFacebookAgent`). Výchozí pro Gemini: `GEMINI_DEFAULT_AGENT_ID` = Eva Gemini V2.
- **Backend:** pole `AI_AGENT_IDS` v `batchCalls.controller.ts` (podle něj se agenti objeví v historii dávek a statistikách — **nový/zrušený agent se musí upravit tady, jinak se dávky „ztratí“**).
- **Prompty Gemini:** v ústředně `src/aiagent/prompts/eva_*_gemini.ts`, výběr podle UUID v mapě `GEMINI_AGENT_PROMPTS` v `geminiService.ts` (neznámý agent → **fallback na V2**).
  V `quantum-be` jsou obdobné soubory promptů pro oba enginy (názvy v `src/aiagent/prompts`; **ověř před úpravou**).
- **Skupina linek podle agenta:** v `jobWorker.ts` (V1/V2/V5 → `pool`, V6–V9 → `fb`). Neznámý agent → úkol skončí `failed`.

### 7.3 Seznam míst, která je při redukci nutné upravit (checklist)

1. `Calling.tsx`: odebrat z `AGENTS` záznamy zrušených agentů; zkontrolovat `GEMINI_DEFAULT_AGENT_ID`, filtry podle enginu a FB.
2. `batchCalls.controller.ts`: `AI_AGENT_IDS` — **ponechat** historická UUID, pokud mají v DB historii hovorů, která má zůstat vidět (zrušením UUID zmizí z přehledů). Ptát se Štěpána.
3. Ústředna: `jobWorker.ts` (mapa agent → skupina), `geminiService.ts` (`GEMINI_AGENT_PROMPTS`, importy promptů), smazat zrušené soubory v `prompts/`.
4. `quantum-be`: mapy promptů/enginů pro OpenAI a Gemini (odstranit zrušené).
5. Uživatelé v DB (`users`) zrušených agentů **nemazat** (cizí klíče z historie `ai_call_logs`); případně `is_active=false` po domluvě.
6. Zkontrolovat, že leady přiřazené zrušeným agentům nezůstaly viset (UPDATE `assigned_to` jen po domluvě; je to data klienta).

---

## 8. Gemini Live: nastavení a chování

- Model **`gemini-3.1-flash-live-preview`** (náhled — Google může chování měnit). WebSocket `…BidiGenerateContent`. Vstup PCM16 16 kHz, výstup PCM16 24 kHz.
- Hlas **`Achernar`**, `language_code: cs-CZ`, `thinking_level: minimal`, `response_modalities: AUDIO`.
- Detekce řeči (VAD): `start/end_of_speech_sensitivity: HIGH`, `prefix_padding_ms: 700`, `silence_duration_ms: 600`. Změna `silence_duration_ms` ovlivní dobu mezi koncem věty zákazníka a odpovědí Evy (a riziko skoku do řeči).
- **Prewarm:** Gemini session se otevře při vyzvánění (setup + velký prompt), „kick-start“ („Zákazník právě zvedl telefon. Zahaj hovor podle FÁZE 1.“) se pošle až po zvednutí (+600 ms). Typická doba od zvednutí do prvního zvuku Evy: **~1,1–1,3 s**.
- **Štít úvodu:** zákazníkův hlas se do Gemini neposílá prvních ~60 % Evina úvodu (`INPUT_SHIELD_PERCENT`, `INPUT_SHIELD_FALLBACK_MS=4000`). Řeší, že Gemini jinak bere „haló“ jako přerušení a pak mlčí. V praxi platí pojistka 4000 ms.
- **Funkce `end_call_with_outcome(outcome, confidence, reason)`** — jediný způsob, jak model předá výsledek. Hodnoty: `interested`, `not_interested`, `callback`, `aggressive`, `already_tmobile`, `wrong_person`, `no_answer`.
- **Posmrtka:** když zákazník zavěsí dřív, než model výsledek zavolal, ústředna do Gemini pošle „Zákazník zavěsil… okamžitě zavolej end_call_with_outcome“ a čeká 5 s. Výsledek přes posmrtku je v DB označen `outcome_source='post_mortem'` (`no_answer` po posmrtce se mapuje na `hung_up`).
- **Přepis řeči zákazníka (`inputTranscription`)** je často chybný („opice“, „lžíce“, „parfois“), i když Eva rozumí správně. Ukládá se do `ai_call_logs.transcript`. Zlepšení je v plánu (§18).
- Prompty jsou **bez personalizace** (Eva nezná jméno ani firmu zákazníka); odkud má číslo → „Číslo bylo náhodně vygenerováno.“

---

## 9. Konec hovoru: ochrana proti opakování věty

**Problém (zjištěno 1. 11. 2026):** model po závěrečné větě **nezavolal hned** funkci s výsledkem; počkal na další vstup (šum, ozvěna Evina hlasu, „děkuji, nashledanou“)
a na něj odpověděl **znovu stejnou závěrečnou větou** (někdy i 4×), než se hovor ukončil. Původní graceful konec se navíc s každým novým zvukem odkládal.

**Řešení (v ústředně, `geminiService.ts` + `asteriskCallHandler.ts`):**

1. Zapnutý **přepis Evina hlasu** (`output_audio_transcription`, výchozí zapnuto; vypnutí `GEMINI_OUTPUT_TRANSCRIPTION=0`).
2. Když přepis obsahuje rozloučení (regex `hezk[ýyíi]|kolega se ozve`), přestane se do Gemini posílat zvuk zákazníka (`🏁 Eva se loučí`).
3. Po konci repliky (turnComplete) se za 0,8 s pošle modelu výzva k zavolání výsledku (`📣`), pokud ho sám nezavolal.
4. Po přijetí výsledku se zvuk zákazníka do Gemini už neposílá (`🔕`); po první replice Evy po výsledku se její další zvuk **zahazuje** (`🔇`).
5. Hovor končí **4 s po výsledku/posledním audiu** (+ zbytek fronty), **nejpozději 10 s po výsledku** + zbytek fronty (pevná pojistka).

**Ověřeno 4 testy:** souhlas (22 s), odmítnutí (16 s), souhlas s přerušením (29 s, jedno opakování, po úpravě regexu se už má chytat i useknutá věta „…Hezký“), souhlas bez přerušení.

**Limity:** spoléhá na to, že Eva řekne slova ze scénáře (jiná formulace → detekce nezabere, chování jako dřív). Slovo „hezký“ je v promptech jen v rozloučení.
**Měření v ostrém provozu:** `grep -c "Function call"` vs. `grep -c "Zahozeno"` v logu (`sudo journalctl -u ustredna-worker --since today | …`).

---

## 10. Výsledky hovorů a stavy leadů

Mapování je **1:1 s původním Quantum/Twilio** (neměnit bez pokynu):

| Gemini výsledek | Stav leadu | Výsledek v `ai_call_logs.outcome` |
|---|---|---|
| `interested` | `CHCE_KONTAKT_AI` | `CHCE_KONTAKT_AI` |
| `not_interested` | `ODMITNUTO` | `NEKONTAKTOVAT` |
| `callback` | `ODKLADA` | `ODKLADA` |
| `aggressive` | `NEKONTAKTOVAT` | `NEKONTAKTOVAT` |
| `already_tmobile` | `NEKONTAKTOVAT` | `NEKONTAKTOVAT` |
| `wrong_person` | `NEKONTAKTOVAT` | `NEKONTAKTOVAT` |
| `no_answer` | `NEZVEDL_TELEFON` | `NEZVEDL_TELEFON` |
| `hung_up` (zvednuto, bez výsledku) | `POLOZIL_TELEFON` | `POLOZIL_TELEFON` |

- Výběr leadů: `status='NOVY' AND assigned_to=$agent AND (ai_call_status IS NULL OR ai_call_status='failed')`, řazeno `created_at`.
- `lead_comments`: `old_status` natvrdo `'NOVY'`, text „🤖 AI hovor dokončen / Výsledek / Délka / poznámky“.
- `ai_call_logs`: `telephony='asterisk'`, `engine='gemini'`, `outcome_source` ∈ {`live`, `post_mortem`, `call_status`}.
- Selhání (chyba po vytočení): lead `ai_call_status='failed'` + řádek v logu `failed`.
- Sledování: stav `NEDOSTUPNY` existuje v `lead_status` (není v `ai_call_outcome`). **Nové stavy** (neexistující číslo / vypnutý telefon / hlasová schránka) zatím nejsou (§18).

---

## 11. Databáze

- **PostgreSQL 16 na Renderu**, databáze `quantum_db_lh1i`, **kapacita 1 GB** (využito ~13 %). Vlastník = role backendu. Migrace spouští vlastník (v pgAdminu).
- **Žádné DB změny bez souboru v `db/migrations/`** (číslované SQL, vždy s `GRANT` pro `voice_bridge`). Struktura: `db/schema-snapshot.md` (po každé migraci aktualizovat).
  Vývojové dotazy patří do `db/dev/`, ne jinam.
- **Role `voice_bridge` (Hetzner):** `ai_call_logs` SELECT/INSERT/UPDATE; `lead_comments` pouze INSERT; `leads` SELECT/UPDATE;
  `users` SELECT jen `id/full_name/is_active`; `batch_jobs` SELECT/UPDATE; `call_recordings` SELECT/INSERT/DELETE.
- Migrace: `001_batch_jobs.sql` (hotovo), `002_call_recordings.sql` (hotovo).
- Klíčové vazby: `ai_call_logs.call_sid varchar(100) UNIQUE` = `callId` (UUID hovoru z ústředny) = `call_recordings.call_sid`; `ai_call_logs.recording_url` = odkaz na nahrávku.
- Pozor na DELETE testovacích leadů: cizí klíče mohou bránit; raději nastavit stav `NEKONTAKTOVAT`.

---

## 12. Fronta úkolů (`batch_jobs`) a spouštění z UI

- Tabulka: `agent_user_id`, `requested_by`, `status` (`pending`/`running`/`completed`/`stopped`/`failed`), `lead_ids uuid[]`, `max_calls`, `queued_leads`, `processed_leads`, `stop_requested`, `error_message`,
  `created_at/started_at/heartbeat_at/finished_at`.
- **Start:** `startAICalling` s `provider='asterisk'` → vynutí `engine='gemini'`, odmítne start, pokud už existuje `pending/running` úkol, zapíše úkol a odpoví (`callMode: 'rotating'`).
- **Stop:** `stopAICalling` zruší `pending` úkoly (`status='stopped'`, `finished_at`) a běžícím nastaví `stop_requested=true`. UI má tlačítko **Stop** s dvojitým potvrzením.
- **Stav pro UI:** `getBatchStatus.isRunning` = existuje lead v `calling` **nebo** aktivní úkol pro agenta (kontrola v `try/catch`). Starý backend stav jen čte z DB.
- **Worker** (`jobWorker.ts`): poll 3 s, jeden úkol najednou, heartbeat, `stop_requested` před každým leadem, úklid po restartu (úkoly `running` → `failed`; leady `calling` starší než 3 min → `failed`),
  SIGTERM → dokončí aktuální lead a skončí.
- **Důsledek:** pokud worker neběží a zůstane `pending` úkol, Hejda ho zruší tlačítkem Stop (nebo to udělá DB). Hejda **nemusí** zastavovat každou dávku ručně — dávka skončí sama po posledním leadu.

---

## 13. Nahrávky hovorů pro klienta

- **Co:** jen hovory s výsledkem `interested` (`RECORD_OUTCOMES`, výchozí `interested`). **Jeden** stereo MP3 na hovor (**levý kanál = zákazník, pravý = Eva**), 16 kHz, 48 kbps ≈ 0,34 MB/min. Kódování `ffmpeg` v paměti (`recordingEncoder.ts`).
- **Kde:** tabulka `call_recordings` (`bytea`) ve sdílené DB. Strop **500 MB** (`RECORDINGS_MAX_MB`); po překročení se nové nahrávky neukládají a loguje se varování.
- **Odkaz:** `ai_call_logs.recording_url = <RECORDINGS_BASE_URL>/api/recordings/<48 hex znaků>.mp3`. Přehrávání zajišťuje `recordings.controller.ts` v tomto repu (veřejné, bez přihlášení, chráněné náhodným 192bitovým tokenem; podporuje `Range`).
  Dashboard, detail dávky („▶ Přehrát“) i export XLSX už `recording_url` četly, takže se UI nemění.
- **Mazání po 14 dnech:** `recordingService.housekeeping()` v ústředně (při startu workeru a pak každých 6 h) smaže řádky v `call_recordings`, vynuluje jejich `recording_url` a smaže lokální `captures/call-*.wav` starší než 14 dní.
- **Vypnutí:** nenastavit `RECORDINGS_BASE_URL` v `.env` ústředny.
- **Proč v DB:** zadavatel nechce platit další službu; objem ~110–150 MB / 14 dní při ~30 zájemcích denně (600 hovorů/den × ~5 % zájemců). Při růstu lze úložiště vyměnit, UI se nezmění (mění se jen `recording_url`).
- **CSP:** helmet má `default-src 'self'`; přehrávání ze stejného původu (quantum-be) proto CSP neřeší. Kdyby se nahrávky přesunuly na jinou doménu, bude potřeba `media-src`.
- Surové WAV pro diagnostiku (`SAVE_CAPTURES`, výchozí zapnuto): `captures/call-<id>-<ts>-eva.wav` a `-zakaznik.wav` na Hetzneru (stahovat `scp`), mažou se po 14 dnech.

---

## 14. Rate limiting a přihlášení (pozor na pasti)

V `server.ts`:

- `/api/` limiter: **1000 požadavků / 15 min / IP**, **GET `/api/ai-calls/batch-status` je vynechán** (UI ho obnovuje každé 3 s). Původní limit 100/15 min vedl k odhlášení a chybě
  *„Unexpected token 'T', "Too many r"…“* (limiter vracel prostý text místo JSON; `AuthContext` navíc bere 429 na `/auth/me` jako odhlášení).
- Login limiter: **5 pokusů / 15 min** (odpověď je teď JSON přes pomocnou funkci `limitMessage()`).
- Při nasazení se limiter v paměti vynuluje (restart procesu).
- Při ladění „vyhodilo mě to / nejde se přihlásit“ nejdřív zkontroluj **429**.

---

## 15. ENV proměnné (obě části)

### 15.1 `quantum-be` (Render)

Beze změny oproti dřívějšku: `DATABASE_URL`, session/JWT, `TWILIO_*` (pozůstatek), `OPENAI_*` (pozůstatek), `GOOGLE_API_KEY`, `ODORIK_API_USER`, `ODORIK_API_PASSWORD`, `ODORIK_BYOC_TRUNK_SID`,
`ODORIK_SIP_NAME_n`, `ODORIK_PHONE_NUMBER`, `ODORIK_PEVNA_SIP_NAME_n`, `ODORIK_PEVNA_PHONE_NUMBER`, `ODORIK_FB_SIP_NAME_n`, `ODORIK_FB_CLIP_n` (vše k cestě přes Twilio, viz Příloha A).
Pro Asterisk cestu **nepotřebuje quantum-be žádné nové ENV** — jen DB.

### 15.2 `ustredna-quantum` (Hetzner, soubor `~/ustredna-quantum/.env`, **není v gitu**)

| Proměnná | Význam |
|---|---|
| `DATABASE_URL` | Sdílená DB, role `voice_bridge` |
| `GOOGLE_API_KEY` | Gemini Live |
| `ARI_PASSWORD` | Heslo uživatele ARI `nodeapp` (shodné s `/etc/asterisk/ari.conf`) |
| `ODORIK_API_USER`, `ODORIK_API_PASSWORD` | REST API Odoriku (jiné než SIP údaje!) |
| `ODORIK_POOL_SIP_NAME_n`, `ODORIK_POOL_CLIP_n` | Identity skupiny `pool` |
| `ODORIK_FB_SIP_NAME_n`, `ODORIK_FB_CLIP_n` | Identity skupiny `fb` |
| `RECORDINGS_BASE_URL` | `https://quantum-1way.onrender.com` (bez lomítka na konci); prázdné = nahrávky vypnuté |
| `RECORD_OUTCOMES` | výchozí `interested` |
| `RECORDINGS_MAX_MB` / `RECORDINGS_RETENTION_DAYS` / `RECORDINGS_BITRATE_KBPS` | 500 / 14 / 48 |
| `GEMINI_OUTPUT_TRANSCRIPTION` | výchozí zapnuto; `0` = vypnout (§9) |
| `SAVE_CAPTURES` | `1` (výchozí) / `0` |
| `INPUT_SHIELD_PERCENT`, `INPUT_SHIELD_FALLBACK_MS` | 60 / 4000 |

Vzor je v `.env.example` v repu ústředny.

---

## 16. Provoz: deploy, logy, testování

### Deploy
- **quantum-be:** commit + `git push` → Render nasadí sám. Frontend je součástí buildu.
- **ustredna-quantum:** na PC commit + `git push origin main`; na serveru `cd ~/ustredna-quantum && ./deploy.sh` (dělá `git pull` + `npm install` + restart; při běžícím úkolu restart odmítne, `--force` obejde).
- Po nasazení vždy: `sudo journalctl -u ustredna-worker -n 30 --no-pager` (služba musí být `active`, v logu `👂 Čekám na úkoly v batch_jobs…`).

### Užitečné příkazy (server)
```
sudo journalctl -u ustredna-worker -f                  # živý log
sudo systemctl status ustredna-worker                  # stav
sudo systemctl stop ustredna-worker / start            # před ručními testy (port 9092)
grep ODORIK_POOL ~/ustredna-quantum/.env               # identity (neposílat hesla)
ffmpeg -version | head -1                              # nahrávky vyžadují ffmpeg
sudo asterisk -rx "core show channels"                 # aktivní kanály
sudo asterisk -rx "pjsip show endpoint odorik"         # stav endpointu
```

### Pravidla testování
- **Testovací hovory pouze na vlastní číslo Štěpána (+420 703 034 160).** Nikdy na ostré leady.
- Testovací leady se jmenují **`TEST …`**. Založení (pgAdmin, vlastník DB):
  ```sql
  INSERT INTO leads (company_name, contact_person, phone, email, status, assigned_to, created_by)
  VALUES ('TEST Nahravka', 'Štěpán', '+420703034160', '', 'NOVY',
          'dab796fa-bf16-4f99-812c-601a031049ce', 'dab796fa-bf16-4f99-812c-601a031049ce')
  RETURNING id;
  ```
  Reset pro další test:
  ```sql
  UPDATE leads SET status='NOVY', ai_call_status=NULL, ai_call_attempts=0, updated_at=NOW()
  WHERE company_name = 'TEST Nahravka';
  ```
- Scénáře k ověření po každé změně hovoru: souhlas („ano chci“), odmítnutí („ne“), souhlas s přerušením závěrečné věty, nezvednutí (50 s), Stop mezi hovory, druhý start při běžícím úkolu.
- Nespuštěné UI testy: **Stop mezi hovory** (3–5 leadů) a **odmítnutí druhého startu** při běžícím úkolu.
- Offline test nahrávky (bez DB): `npx tsx src/testRecording.ts <eva.wav> <zakaznik.wav> /tmp/test.mp3 [kbps]`.
- `runBatch.ts --agent <uuid> [--group pool|fb] [--leads id1,id2] [--max N] [--go]` — bez `--go` jen vypíše plán.

---

## 17. Diagnostika: co znamenají řádky v logu a co dělat

| Řádek v logu | Význam | Akce |
|---|---|---|
| `▶️ Úkol … leadů N` | Worker převzal úkol | OK |
| `Odorik forward set … status: 200 … ringing_number: *087…` | Route nastavena | OK; pokud je v `data` `errors`, viz §5.5 |
| `🛫 [Asterisk] Prewarm started` / `Prewarm session ready` | Gemini připravené během vyzvánění | OK |
| `📞 [Dialer] Zvednuto` | Zákazník zvedl | OK |
| `Nezvednuto: no-answer (ringing=false, alive=50018 ms, cause=0)` | Odorik nic nevrátil (sporadické) | Zopakovat; opakuje-li se → Odorik |
| `Nezvednuto: busy (cause=17)` | Obsazeno | Stav leadu `NEZVEDL_TELEFON` |
| `🏁 Eva se loučí` / `📣` / `🎯 Function call` / `🔕` | Konec hovoru podle §9 | OK |
| `🔇 Zahozeno … ms opakovaného zvuku` | Eva se pokusila zopakovat větu a my to zahodili | Sledovat četnost |
| `🛑 Graceful end po výsledku` / `⏰ Pevný konec po výsledku` | Regulérní/pojistkový konec | OK |
| `🎙️ [Recording] Uloženo … KB` | Nahrávka v DB, odkaz u leadu | OK |
| `⚠️ [Recording] Strop … by byl překročen` | Tabulka `call_recordings` plná | Počkat na úklid / zvýšit strop |
| `❌ [Asterisk] Socket chyba: read ECONNRESET` po úklidu | Neškodné — Asterisk zavřel spojení těsně po zavěšení | Ignorovat |
| `Smazáno lokálních WAV … / nahrávek starších než 14 dní` | Úklid | OK |
| `⚠️ [Gemini] No Gemini prompt for agent …, falling back to v2` | Neznámý agent | Doplnit mapu promptů |
| Úkol `failed` s „Restart workeru“ | Worker se restartoval při běhu | Spustit znovu |

---

## 18. Známé problémy a otevřené body (roadmap)

Pořadí, jak to Štěpán domluvil:

1. **Kvalita přepisu a odstranění zbytečného převodu zvuku** (PCM→µ-law→PCM zděděný z Twilia; `audioConverter.ts` zachoval název `twilioToGemini`, `audioSocketAdapter.ts` dělá mezi AudioSocketem a ním adaptaci). Zlepšit `inputTranscription`, analyzovat `-zakaznik.wav`.
2. **Dokončit testy Stop a druhého spuštění** v UI.
3. **Paralelní režim:** Hejda plánuje ~3 souběžné hovory. Podmínky: 1 SIP jméno = 1 souběžný hovor; pool má **5** linek; server má 1 vCPU / 2 GB RAM (zátěž hlídat); orchestrátor je dnes sériový (rotace).
4. **Nové stavy:** neexistující číslo, vypnutý telefon, hlasová schránka. Nejdřív sledovat **surová data z Odoriku** (SIP příčiny, `cause`), pak rozhodnout o mapování.
5. **FB agenti přes Asterisk** (dnes UI FB agenty při provideru Asterisk skrývá; skupina `fb` ve workeru existuje; FB V9 musí jít i přes Twilio/Odorik+Twilio).
6. **Redukce agentů** (§7).
7. **Odpojení Twilia** (§3.3).
8. **Watchdog 90 s** (hovor nikdy > 90 s včetně vytáčení): úplně na konec. Po prvním nasazení Eva mlčela ~5 s v úvodu; po vrácení původního `ariDialer.ts` ne. Příčina nenalezena. Požadavek zůstává.

Další poznámky:
- Přes 3000 leadů bylo při testech přesunuto k agentovi Eva V5; **může být potřeba je vrátit původnímu agentovi** (rozhodne Štěpán).
- Pravidlo „nejdřív 1:1 s Twiliem, vylepšení potom“: vylepšení se zapisují stranou a dělají se po odpojení Twilia; výjimky (ochrana konce hovoru, nahrávky) schválil zadavatel.
- Citlivost přerušení (VAD) a doba odezvy Evy se dají ladit, ale pozor na skákání do řeči.

---

## 19. Pravidla spolupráce se zadavatelem

Zadavatel: **Štěpán** (Praha, česky, neformálně; pracuje ve WebStormu na Windows). Klient: **Roman Hejda / Cante Trading** (T-Mobile partner).

- Piš **česky**, stručně a konkrétně; **nepřeháněj** přemýšlením a nabídkami.
- Dávej **celé soubory** (ne útržky) a **postup krok za krokem** (kam soubor uložit, jaké příkazy spustit, jak ověřit).
- **Neměň to, co funguje.** Nejdřív 1:1, vylepšení až potom. U rizikových změn dej přepínač v `.env` nebo malou, vratnou úpravu.
- **Žádné SQL mimo `db/migrations/`** (vývojové dotazy do `db/dev/`). Informace o DB a migracích udržuj v `.md` souborech v repu.
- **Hetzner zůstává uzavřený.** Žádné nové placené služby pro Hejdu.
- **Testy hovorů jen na vlastní číslo**; testovací leady `TEST …`.
- Do repa nikdy nedávej **hesla ani klíče**. (Pozor: starší verze tohoto dokumentu obsahovala SIP heslo linky 793305; v této verzi je odstraněno, ale **zůstává v historii gitu** — zvážit změnu hesla linky.)
- Před kódováním si vyžádej aktuální soubory (`git` na PC se může lišit od toho, co máš z dřívějška). `quantum-be` a `ustredna-quantum` jsou **dvě oddělená repa**.
- Export kódu do nové konverzace: `export-code.ps1` v ústředně vytvoří `ustredna_quantum_export.txt`; pro `quantum-be` obdobně.

---

# Příloha A — původní řešení Twilio + Odorik BYOC (archiv)

> **Stav:** funkční, ale **nepoužívá se** (nahrazeno ústřednou). Zachováno jako záloha a jako referenční příklad migrace. Tuto přílohu nemaž.
> Verze textu z 21. 9. 2026 (druhá linka, opravy nepřesností). Co se mezitím změnilo, je v hlavní části výše.

## A.1 Architektura

```
Backend → Odorik API (setForward: SIP jméno → cílové číslo)
       → Twilio API (client.calls.create: to = sip:SIP_JMENO@sip.odorik.cz, byoc = trunk SID)
       → Twilio BYOC trunk → Odorik SIP proxy
       → Odorik přesměruje hovor na cílové číslo s CLIP dané linky
       → klient vidí CLIP linky, ze které se volá, ne pevnou linku Twilia
```

**Klíčový princip (platí i pro ústřednu):** Odorik nedovolí volat přímo na libovolné číslo přes SIP. Má **SIP jména / veřejná čísla**, která se před KAŽDÝM hovorem přes REST API dynamicky
přesměrují na skutečné cílové číslo; teprve pak se na SIP jméno zavolá (tehdy přes Twilio, dnes přes Asterisk).

## A.2 Zřízení SIP jména

**a) Přes Odorik (Petr Soukup):** SIP linka + heslo, REST API user/password (JINÉ než SIP údaje), pevné číslo linky (Twilio „from“).
**b) Samoobslužně (21. 9. 2026):** administrace Odoriku → průvodce nastavením → pro linku → „Vlastní telefonní číslo“ → „SIP jména“ → „Přidání nového SIP jména“. Formát: dlouhá výstižná jména, `_` nebo `.`, bez diakritiky.
Ověřeno naostro: jméno `hejda_pevna1` fungovalo v API okamžitě. T-Mobile schvalování (Odorik běží na T-Mobile) nemusí být univerzální — počítat s možností čekání a vždy otestovat živě.
Nebyl potřeben IP whitelist Twilio rozsahů.

## A.3 Odorik REST API (Public Numbers)

Base URL `https://www.odorik.cz/api/v1`, dokumentace https://www.odorik.cz/w/api:public_numbers. Poučky 1–3 viz §5.5. Endpointy:

```
GET    /public_numbers/{sipName}/routes.json?user=..&password=..
DELETE /public_numbers/{sipName}/routes/{routeId}.json?user=..&password=..
POST   /public_numbers/{sipName}/routes.json     (form-urlencoded: user, password, source_number=*, ringing_number=*087…)
```

Formát čísla: `*08700420XXXXXXXXX` nebo `*087XXXXXXXXX`; ne `*087+420…`. Normalizace: `+420703034160` / `00420703034160` / `703034160` → `00420703034160` → s předponou.
1 worker = 1 SIP jméno (jinak závod o přesměrování).

## A.4 Twilio strana — BYOC trunk

1. **BYOC trunk** v Twilio Console. Jeden trunk (`Odorik BYOC`, SID `BY40d710bc9044404d8c3cd49da59cab5d`) zvládá **více linek téhož Odorik účtu** (ověřeno 21. 9. 2026); pro **jiného klienta/projekt** zakládat nový.
2. **Origination Connection Policy** (směr Twilio → Odorik): funkční produkční Target URI je pouze **`sip:sip.odorik.cz`, BEZ credentials**. (Starší verze dokumentu tvrdila `sip:USER:PASS@sip.odorik.cz`; produkce ale prokazatelně funguje bez nich. Pro nového klienta zkusit nejdřív holé URI.)
3. **Termination SIP Domain** (opačný směr) pro čistě odchozí volání pravděpodobně nepotřeba.

Volání z backendu:

```javascript
client.calls.create({
  to: 'sip:hejda_test1@sip.odorik.cz',   // SIP jméno, ne telefonní číslo
  from: odorikNumber,                     // CLIP dané linky
  byoc: odorikTrunkSid,                   // SID BYOC trunku (společný pro obě linky)
  url: '.../webhook/twiml',
});
```
V `normalizePhoneNumber()` se při prefixu `sip:` přeskakuje validace E.164.

## A.5 Tok hovoru (Twilio varianta)

1. Worker (přiřazený SIP jménu a lince) vezme lead z fronty. 2. `deleteAllRoutes(sipName)`. 3. `setForward(sipName, leadPhone)` s `*087…`.
4. `client.calls.create({ to: 'sip:{sipName}@sip.odorik.cz', from: CLIP, byoc: trunkSid })`. 5. Twilio → INVITE → Odorik přes BYOC.
6. Odorik najde route a přesměruje hovor s CLIP linky. 7. Zákazník zvedne, AI mluví přes Twilio Media Stream WebSocket.

## A.6 ENV (Twilio varianta)

```
ODORIK_API_USER, ODORIK_API_PASSWORD          # společné pro celý účet
ODORIK_BYOC_TRUNK_SID                          # společný pro všechny linky
ODORIK_SIP_NAME_1.._n     + ODORIK_PHONE_NUMBER (703614594)         # mobilní 790766
ODORIK_PEVNA_SIP_NAME_1.. + ODORIK_PEVNA_PHONE_NUMBER (217217749)   # pevná 793305
ODORIK_FB_SIP_NAME_n + ODORIK_FB_CLIP_n                              # FB skupina
```
Do `…SIP_NAME_n` patří **jen ověřeně funkční** SIP jména. Backend čte sekvenčně `_1`, `_2`… a končí na první mezeře; počet jmen = počet paralelních workerů linky.
Credentials SIP linky se do ENV nedávají (v produkčním trunku se nepoužívají).

## A.7 Známé chyby (Twilio varianta)

| Problém | Příčina | Řešení |
|---|---|---|
| API vrací 200, route se neuloží | Basic Auth místo query/form parametrů | `user`/`password` jako parametry |
| Hovor jde na staré číslo | Stará route zůstala | `deleteAllRoutes()` před `setForward()` |
| 200 OK s `{"errors":[…]}` logováno jako úspěch | Kontrola jen HTTP statusu | Číst `response.data.errors` |
| `nonexisting_public_number` | Holé číslo linky není v Public Numbers API | Vytvořit SIP jméno |
| Divné CLIP | Špatný formát `ringing_number` (s `+`) | `*08700420…` |
| Dva hovory přepisují přesměrování | Sdílené SIP jméno | 1 worker = 1 SIP jméno |
| Nové jméno nefunguje | Možné schvalování u T-Mobile | Počkat; nedávat do ENV; testovat živě |

## A.8 Aplikační vrstva (Twilio varianta)

`odorikService.ts` (REST klient: `getActiveSipNames(line)`, `getPhoneNumberForLine(line)`, `getIdentitiesForLine(line)`, `setForward()`, `deleteAllRoutes()`),
`callOrchestrator.ts` (provider/engine/linka nezávislé parametry), `POST /api/ai-calls/start` (`provider: 'twilio'|'odorik'|'asterisk'`, `engine: 'openai'|'gemini'`, `odorikLine: 'mobilni'|'pevna'|'fb'`),
frontend `Calling.tsx` (přepínač linky jen u `provider==='odorik'`).

## A.9 Historie a ekonomika

Přímý Twilio hovor na českou mobilní síť ~0,15 USD/min; Odorik přes BYOC ~0,004 USD/min poplatek Twilia + vlastní tarif Odoriku (analýza z 22. 9. 2026).
Zákazník navíc u přímého Twilia vidí zahraniční číslo, což zhoršuje zvedání. Vlastní ústředna (Asterisk + Odorik) odstraňuje i poplatky Twilia.

## A.10 Druhá Odorik linka — pevná pražská 793305 (21. 9. 2026)

Důvod: mobilní linka 790766 (CLIP 703614594) měla dlouhodobě horší úspěšnost zvednutí; přidána nezávislá pevná linka pro A/B porovnání.

| Položka | Hodnota |
|---|---|
| Číslo v síti | 793305 |
| Veřejné číslo / CLIP | 217217749 |
| SIP proxy | sip.odorik.cz |
| SIP jméno | `hejda_pevna1` (samoobslužně) |

(U 790766 je veřejné číslo a CLIP oddělené a existují aliasy `hejda_test1/2`; u 793305 je veřejné číslo = CLIP.)
Obě linky fungují přes **stejný** Twilio BYOC trunk. Další linka by nemusela potřebovat nový trunk — stačí SIP jméno a ENV s CLIP.
Postup zavedení: zjistit linku v administraci → ověřit, že holé číslo není v API → vytvořit SIP jméno → ověřit `setForward` → živý zkušební hovor (CLIP na displeji potvrzen).