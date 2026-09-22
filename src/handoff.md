# Twilio + Odorik BYOC setup — kompletní návod
**(aktualizováno 21.9.2026 — přidána druhá Odorik linka, opraveny dvě
nepřesnosti z původní verze na základě živého ladění)**

Tento dokument shrnuje **funkční, produkčně ověřenou** konfiguraci pro
volání přes Twilio s Odorik mobilním/pevným CLIP (caller ID). Vychází
z reálného nasazení pro Quantum CRM (klient Roman Hejda / Cante
Trading).

---

## 1. Architektura — jak to celé funguje

Backend → Odorik API (setForward: SIP jméno → cílové číslo)
→ Twilio API (client.calls.create: to = sip:SIP_JMENO@sip.odorik.cz, byoc = trunk SID)
→ Twilio BYOC trunk → Odorik SIP proxy
→ Odorik přesměruje hovor na cílové číslo s CLIP dané linky
→ Klient vidí CLIP té linky, ze které se volá, ne Twilio pevnou linku


**Klíčový princip:** Odorik nedovolí volat přímo na libovolné cílové
číslo přes SIP. Místo toho má tzv. **"veřejná čísla" / SIP jména**,
která se před KAŽDÝM hovorem přes REST API dynamicky přesměrují na
skutečné cílové číslo. Teprve pak se přes Twilio zavolá na to SIP
jméno.

**⚠️ Od 21.9.2026 podporujeme DVĚ nezávislé Odorik linky současně**
(mobilní 790766 a pevná 793305) — sdílejí stejnou Twilio BYOC
infrastrukturu, liší se jen CLIP a sadou SIP jmen. Viz sekce 11.

---

## 2. Zřízení SIP jména — DVĚ cesty

### 2a) Přes email Petru Soukupovi (Odorik)

Pro nový účet/projekt/linku je nutné od Odoriku (kontakt: Petr
Soukup) získat:

1. **SIP linka + přihlašovací údaje** — číslo linky + heslo.
2. **REST API přístup** (Public Numbers API) — API user + API
   password. **Toto jsou JINÉ credentials než SIP linka** — nezaměňovat.
3. **Pevné číslo linky** — použije se jako Twilio "from" parametr.

### 2b) ⚠️ NOVÉ (21.9.2026) — samoobslužně přes Odorik administraci

**Zjištěno naživo:** SIP jméno lze zřídit i BEZ čekání na Petra
Soukupa, přímo v Odorik webové administraci:

1. Přihlásit se do Odorik administrace (odorik.cz/ucet)
2. Záložka "průvodce nastavením" → v dropdownu "pro linku" vybrat
   konkrétní linku
3. Druhý dropdown: "Vlastní telefonní číslo / příchozí hovory /
   přístupová čísla" → "Vlastní telefonní číslo"
4. Třetí dropdown: "SIP jména"
5. Do pole "Přidání nového SIP jména" zadat název a kliknout "přidat"

Doporučený formát názvu (dle nápovědy přímo na stránce Odoriku):
dlouhá výstižná jména, oddělovač `_` nebo `.`, **bez diakritiky**.

**Ověřeno naostro (21.9.2026):** SIP jméno `hejda_pevna1` vytvořené
tímto samoobslužným postupem začalo fungovat v Public Numbers API
**okamžitě** — žádné zjevné čekání na schválení u T-Mobile.

**⚠️ Nejistota k dořešení:** Není jasné, jestli T-Mobile schvalovací
proces (viz níže) platí univerzálně pro všechna nová SIP jména, nebo
jen pro určitý typ zřízení. Pro jistotu počítat s možností delšího
čekání a vždy živě otestovat před nasazením do produkce.

### Co dál platí beze změny

**Nové SIP jméno musí být (možná) schváleno u T-Mobile** (Odorik běží
na T-Mobile síti), než přes něj půjde reálně volat. Toto schválení
může trvat delší dobu (týdny) — u Hejdy bylo `hejda_test1` schváleno
rychle, `hejda_test2` čekalo na schválení mnohem déle, `hejda_pevna1`
(zřízené samoobslužně) zjevně vůbec nečekalo. Backend musí číst pouze
schválená/funkční SIP jména z ENV.

**Co NENÍ potřeba žádat:** IP whitelist Twilio rozsahů. Finální
fungující řešení je čistě přes SIP jména + REST API forwarding, žádný
IP whitelist se nepoužívá.

---

## 3. Odorik REST API — Public Numbers

**Base URL:** `https://www.odorik.cz/api/v1`
**Dokumentace:** https://www.odorik.cz/w/api:public_numbers

### Kritická poučka č. 1 — formát autentizace

Odorik API **NEPOUŽÍVÁ HTTP Basic Auth**. Credentials (`user`,
`password`) se posílají jako **query/form parametry** přímo v
requestu. Použití Basic Auth vede k tichému selhání — API vrátí
`200 OK`, ale route se ve skutečnosti neuloží.

### Kritická poučka č. 2 — vždy smazat staré routes před nastavením nových

**Než se nastaví nové přesměrování, MUSÍ se smazat všechny existující
routes na daném SIP jménu.** Bez tohoto kroku zůstává aktivní staré
přesměrování a hovor jde na špatné číslo. Řešení: `deleteAllRoutes(sipName)`
se volá VŽDY před `setForward()`.

### ⚠️ Kritická poučka č. 3 (NOVÁ, 21.9.2026) — Odorik API vrací chyby s HTTP 200

**Odorik API nepoužívá chybové HTTP statusy pro věcné chyby.** Zjistili
jsme naživo, že dotaz na neregistrované/neexistující veřejné číslo
vrátí:

POST /public_numbers/217217749/routes.json
→ HTTP 200
→ body: {"errors":["nonexisting_public_number"]}


**Kód, který kontroluje jen HTTP status 200 (bez čtení
`response.data.errors`), tohle vyhodnotí jako ÚSPĚCH** — přesměrování
se ve skutečnosti vůbec nenastavilo, ale nic to nenahlásí. Tenhle bug
byl objeven a opraven v `odorikService.ts` 21.9.2026 —
`setForward()` teď `response.data.errors` kontroluje explicitně a v
tom případě vyhodí skutečnou chybu.

**Poučení pro budoucí ladění:** při diagnostice "hovor se nedovolal,
ale API hlásilo úspěch" vždy zkontrolovat SUROVÉ tělo odpovědi, ne jen
HTTP status.

**Související zjištění:** holé číslo linky (to, co se v administraci
zobrazuje jako "Veřejné telefonní číslo") **není automaticky
routovatelné přes Public Numbers API**, i když v administraci existuje
a vypadá funkčně. Musí pro něj existovat samostatně vytvořené SIP
jméno (viz sekce 2), teprve to je API-registrované.

### Endpointy

**GET routes** — zjištění aktuálních routes na SIP jméně:

GET /public_numbers/{sipName}/routes.json?user={apiUser}&password={apiPassword}


**DELETE route** — smazání konkrétní route podle ID:

DELETE /public_numbers/{sipName}/routes/{routeId}.json?user={apiUser}&password={apiPassword}


**POST nová route** — nastavení přesměrování (form-urlencoded body,
ne JSON):

POST /public_numbers/{sipName}/routes.json
Content-Type: application/x-www-form-urlencoded

user={apiUser}&password={apiPassword}&source_number=*&ringing_number={formatovane cislo}


### Formát volaného čísla — prefix *087

Aby se na klientovi zobrazilo správné CLIP (ne Twilio pevná linka),
musí být cílové číslo ve formátu s prefixem `*087`.

Dvě fungující varianty formátu:
- `*08700420737007770` — prefix *087 + mezinárodní formát BEZ znaku
  `+` (00 + 420 + číslo)
- `*087737007770` — prefix *087 + národní formát (jen 9 číslic, bez
  předvolby)

**Nedoporučeno:** varianta s `+` (`*087+420...`).

Produkční implementace používá mezinárodní variantu (00420). Logika
převodu:
- Vstup může být `+420703034160`, `00420703034160`, nebo `703034160`
- Vše se normalizuje na formát `00420XXXXXXXXX` (bez `+`)
- Před to se přidá prefix `*087`
- Výsledek: `*08700420703034160`

### SIP jména = veřejná čísla

V URL cestách API (`/public_numbers/{X}/routes.json`) se místo
telefonního čísla použije přímo název SIP jména (např.
`hejda_test1`, `hejda_pevna1`), bez jakékoli úpravy formátu.

### Proč více SIP jmen = paralelní hovory

Jedno SIP jméno = jedno přesměrování aktivní v jeden okamžik. Pokud by
dva souběžné hovory sdílely stejné SIP jméno, druhé přesměrování by
přepsalo první dřív, než by se stihl hovor dokončit → race condition.
Proto: **1 worker = 1 SIP jméno**, žádné sdílení.

---

## 4. Twilio strana — BYOC (Bring Your Own Carrier) Trunk

### Krok 1 — Vytvoření BYOC trunku

V Twilio Console vytvořit nový BYOC Trunk.

**⚠️ ZMĚNA (21.9.2026):** Původní verze tohoto dokumentu doporučovala
trunk vytvářet "samostatný pro každý projekt/firmu, ne sdílený". Toto
platí pro RŮZNÉ projekty/klienty (např. Quantum vs. VF-CRM), ale
**NEPLATÍ pro více linek téhož Odorik účtu** — viz sekce 11.3 níže,
kde je naživo ověřeno, že jeden BYOC trunk zvládá více Odorik linek
současně.

### Krok 2 — Origination Connection Policy

Řídí směr **Twilio → Odorik** (odchozí hovory iniciované backendem).

**⚠️ OPRAVA (21.9.2026) — rozpor s původním textem:**

Původní verze tohoto dokumentu tvrdila, že funkční řešení jsou
credentials vložené přímo do Origination URI:

sip:{SIP_LINKA_USER}:{SIP_LINKA_PASSWORD}@sip.odorik.cz


**Prohlédli jsme si naživo produkční trunk ("Odorik BYOC", SID
`BY40d710bc9044404d8c3cd49da59cab5d`), který reálně a prokazatelně
funguje pro linku 790766** — jeho Origination Target URI je pouze:

sip:sip.odorik.cz


**BEZ jakýchkoliv credentials.** Nevíme jistě, proč se to od
zdokumentovaného stavu liší (možná se nastavení v mezičase
zjednodušilo, možná dokument popisoval jinou fázi ladění, možná byl
tenhle detail od začátku nepřesný). Faktem je, že **aktuální produkční
nastavení funguje bez credentials v URI** a autentizace/routing na
Odorik straně zjevně probíhá jinak — pravděpodobně přes kombinaci
Caller ID (`From` číslo) a cílového SIP jména v `To` poli, ne přes
per-linka SIP autentizaci na Twilio trunku.

**Praktický důsledek:** při zakládání nové Odorik linky (nebo nového
klienta) vyzkoušet nejdřív holé `sip:sip.odorik.cz` bez credentials —
podle všeho to funguje a je to jednodušší.

Postup v Twilio Console: BYOC Trunk → Origination Connection Policy →
Destination → Edit origination policy → Target URI.

### Krok 3 — Termination SIP Domain (pravděpodobně NENÍ potřeba)

Řeší opačný směr (Odorik → Twilio, inbound), který pro čistě odchozí
volací flow není nutný. Doporučení: zkusit nejdřív BEZ konfigurace
Termination SIP Domain.

### Volání z backendu

```javascript
client.calls.create({
  to: 'sip:hejda_test1@sip.odorik.cz',   // SIP jméno, ne telefonní číslo
  from: odorikNumber,                     // CLIP dané linky (ODORIK_PHONE_NUMBER nebo ODORIK_PEVNA_PHONE_NUMBER)
  byoc: odorikTrunkSid,                   // SID BYOC trunku — SPOLEČNÝ pro obě linky
  url: '.../webhook/twiml',
  // ... zbytek standardních Twilio call parametrů
})
```

Poznámka: v `normalizePhoneNumber()` je potřeba detekovat prefix
`sip:` a v tom případě přeskočit běžnou E.164 validaci telefonního
čísla.

---

## 5. Kompletní flow jednoho hovoru (pořadí kroků)

1. Worker (přiřazený ke konkrétnímu SIP jménu a Odorik lince) si
   vezme lead z fronty
2. Backend zavolá Odorik API: `deleteAllRoutes(sipName)` — smaže staré
   přesměrování
3. Backend zavolá Odorik API: `setForward(sipName, leadPhone)` —
   nastaví nové přesměrování ve formátu `*087...`
4. Backend zavolá Twilio API: `client.calls.create({ to:
   'sip:{sipName}@sip.odorik.cz', from: {CLIP dané linky}, byoc:
   trunkSid, ... })`
5. Twilio odešle SIP INVITE na Odorik přes BYOC trunk
6. Odorik přijme INVITE na dané SIP jméno, najde aktivní přesměrování
   (z kroku 3) a přesměruje hovor na cílové číslo s CLIP té linky, ze
   které se volá
7. Klient vidí CLIP dané linky, zvedne, AI agent mluví přes standardní
   Twilio Media Stream WebSocket

---

## 6. ENV proměnné potřebné v backendu

ODORIK_API_USER=<REST API user od Odoriku — společný pro celý účet, obě linky>
ODORIK_API_PASSWORD=<REST API heslo od Odoriku — společný pro celý účet, obě linky>
ODORIK_BYOC_TRUNK_SID=<SID Twilio BYOC trunku — SPOLEČNÝ pro obě linky>

Mobilní linka (790766)

ODORIK_SIP_NAME_1=<první SCHVÁLENÉ/FUNKČNÍ SIP jméno mobilní linky>
ODORIK_SIP_NAME_2=<druhé SCHVÁLENÉ/FUNKČNÍ SIP jméno mobilní linky, pokud existuje>
ODORIK_PHONE_NUMBER=<CLIP mobilní linky — 703614594>

Pevná linka (793305) — NOVÉ 21.9.2026

ODORIK_PEVNA_SIP_NAME_1=<první FUNKČNÍ SIP jméno pevné linky — hejda_pevna1>
ODORIK_PEVNA_PHONE_NUMBER=<CLIP pevné linky — 217217749>


**Kritické pravidlo:** Do `ODORIK_SIP_NAME_X` / `ODORIK_PEVNA_SIP_NAME_X`
proměnných se smí dávat POUZE SIP jména, která jsou ověřeně funkční
(otestovaná živým hovorem). Backend čte tyto proměnné sekvenčně (`_1`,
`_2`, `_3`...) a zastaví se na první mezeře — počet nalezených jmen =
počet dostupných paralelních workerů pro danou linku.

SIP linka credentials (číslo linky + heslo pro Origination URI) —
podle zjištění v sekci 4 se aktuálně NEPOUŽÍVAJÍ v produkčním trunku
vůbec, takže se nikam do ENV nedávají.

---

## 7. Shrnutí známých chyb a jejich řešení

| Problém | Příčina | Řešení |
|---|---|---|
| API vrací 200 OK, ale route se neuloží | Použití HTTP Basic Auth místo query/form parametrů | Credentials posílat jako `user`/`password` v query stringu nebo form body |
| Hovor jde na staré/špatné číslo | Stará route zůstala aktivní na SIP jméně | Vždy `deleteAllRoutes()` PŘED `setForward()` |
| API vrací 200 OK s `{"errors":[...]}`, kód to loguje jako úspěch | Kód nekontroluje `response.data.errors`, jen HTTP status | Explicitní kontrola `response.data.errors` v `setForward()`/`getRoutes()` — opraveno 21.9.2026 |
| `nonexisting_public_number` chyba | Holé číslo linky není registrované jako veřejné číslo v Public Numbers API | Vytvořit SIP jméno pro danou linku (samoobslužně, viz sekce 2b) |
| CLIP se nepřenáší správně / zákazník vidí divné číslo | Chybný formát ringing_number (např. s `+` místo `00`) | Použít `*08700420XXXXXXXXX` (bez `+`) |
| Dva souběžné hovory si "přepisují" přesměrování | Sdílené jedno SIP jméno mezi dvěma workery | Striktně 1 worker = 1 SIP jméno |
| Nové SIP jméno nefunguje i přes správnou konfiguraci | Případně čeká na schválení u T-Mobile (ne vždy — viz sekce 2b) | Počkat na schválení, do té doby nedávat jméno do ENV; otestovat živě |

---

## 8. Co bude potřeba specificky pro nový projekt/klienta

Oproti Hejdovu/Quantum nastavení bude nutné:

1. Nový, samostatný Twilio BYOC trunk (ne sdílet s Hejdovým — platí
   pro RŮZNÉ klienty/projekty; pro více linek TÉHOŽ klienta viz
   sekce 11.3, tam sdílení funguje)
2. Nová sada Odorik credentials — SIP linka, REST API user/password,
   SIP jméno
3. Origination Connection Policy — vyzkoušet nejdřív bez credentials
   v URI (viz oprava v sekci 4), případně s credentials, pokud holé
   `sip:sip.odorik.cz` nefunguje
4. Backend kód lze převzít 1:1 stejný jako u Quantum — mění se jen ENV
   hodnoty, žádná logika

---

## 9. Aplikační vrstva v Quantum backendu (odkaz)

Odorik logika je rozdělená do:
- `src/aiagent/services/odorikService.ts` — REST API klient,
  `getActiveSipNames(line)`, `getPhoneNumberForLine(line)`,
  `setForward()`, `deleteAllRoutes()`
- `src/aiagent/services/callOrchestrator.ts` — orchestrace hovoru,
  přijímá `provider`/`engine`/`odorikLine` jako nezávislé parametry
- `POST /api/ai-calls/start` — přijímá `provider: 'twilio'|'odorik'`,
  `engine: 'openai'|'gemini'`, `odorikLine: 'mobilni'|'pevna'`
- Frontend `Calling.tsx` — přepínač linky viditelný jen když je
  vybraný `provider === 'odorik'`

---

## 10. Historie: proč vůbec Odorik místo přímého Twilio

Přímý Twilio hovor na českou mobilní síť je řádově dražší (viz cenová
analýza z 22.9.2026 — Twilio přímé volání na mobil ČR ~$0.15/min vs.
Odorik BYOC ~$0.004/min Twilio poplatek + Odorik vlastní tarif) a
zákazník navíc vidí cizí/zahraniční číslo místo českého mobilního
CLIP, což zjevně zhoršuje answer rate.

---

## 11. DRUHÁ ODORIK LINKA — pevná pražská 793305 (NOVÉ, 21.9.2026)

### 11.1 Kontext

Mobilní linka 790766 (CLIP 703614594) měla dlouhodobě zhoršující se
answer rate — zákazníci ji pravděpodobně začali rozpoznávat/blokovat
jako podezřelé/spamové číslo. Řešení: přidat druhou, nezávislou
Odorik linku s jiným CLIP — pevnou pražskou — a umožnit v aplikaci
volbu mezi nimi (A/B test answer rate).

### 11.2 Údaje o nové lince

| Položka | Hodnota |
|---|---|
| Číslo v síti (linka) | 793305 |
| Veřejné telefonní číslo / CLIP | 217217749 |
| SIP proxy | sip.odorik.cz (stejný jako u 790766) |
| SIP jméno (vytvořeno samoobslužně, viz sekce 2b) | hejda_pevna1 |
| SIP heslo linky (pro referenci — v produkčním trunku se nepoužívá, viz sekce 4) | 16oQDkeDAVAs |

Na rozdíl od linky 790766 (kde je "veřejné telefonní číslo" a CLIP
oddělené a existují navíc dva SIP jméno aliasy hejda_test1/
hejda_test2), u linky 793305 je veřejné číslo a CLIP STEJNÁ hodnota
(217217749) — SIP jméno hejda_pevna1 je až doplněk vytvořený navíc
pro účely API routingu.

### 11.3 KLÍČOVÉ ZJIŠTĚNÍ — sdílený Twilio BYOC trunk

Testem ověřeno (21.9.2026): **obě linky (790766 i 793305) fungují přes
STEJNÝ Twilio BYOC trunk** (`BY40d710bc9044404d8c3cd49da59cab5d`,
"Odorik BYOC"). Nebyl potřeba žádný druhý trunk, i když jsme s ním
původně počítali.

**Praktický důsledek pro budoucnost:** přidání další (třetí, čtvrté...)
Odorik linky pravděpodobně NEBUDE vyžadovat nový BYOC trunk — stačí
nové SIP jméno vytvořené na dané lince a nová ENV proměnná s CLIP
číslem té linky.

### 11.4 Proces zřízení — postup, jak byla 793305/hejda_pevna1 uvedena do provozu

1. Zjistit z Odorik administrace (tabulka "Máte k dispozici následující
   linky"), že nová linka existuje a jaké má veřejné číslo/CLIP
2. Zjistit, že HOLÉ číslo linky (217217749) NENÍ samo o sobě
   registrované v Public Numbers API — test `GET
   /public_numbers/217217749/routes.json` vrátí
   `{"errors":["nonexisting_public_number"]}`
3. Vytvořit SIP jméno pro tuhle linku samoobslužně v Odorik
   administraci (viz sekce 2b) — `hejda_pevna1`
4. Ověřit, že nové SIP jméno JE registrované: `setForward('hejda_pevna1',
   ...)` proběhne bez chyby, s validním `data.id`
5. Živý testovací hovor (Twilio `calls.create` se STÁVAJÍCÍM BYOC
   trunk SID, `to: sip:hejda_pevna1@sip.odorik.cz`, `from:
   +420217217749`) — potvrzeno: zákazník zvedne, CLIP na displeji je
   217217749

Celý proces od "zjištění nové linky v administraci" po "ověřený
funkční hovor" proběhl samoobslužně, bez nutnosti čekat na odpověď od
Petra Soukupa.

### 11.5 ENV proměnné — viz sekce 6 výše (kompletní aktuální seznam)

### 11.6 Aplikační vrstva — viz sekce 9 výše