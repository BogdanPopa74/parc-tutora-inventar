# Inventar parc fotovoltaic Țuțora

Aplicație web pentru inventarul parcului: harta cu toate mesele și panourile, scanarea seriilor cu
telefonul, fișe pentru PTAB/STS, invertoare, stâlpi și alte echipamente, tabel cu date pentru
verificare pe laptop și sincronizare live între dispozitive. Nu are server propriu și nu are pas de build.

- `docs/index.html`, `docs/app.css`, `docs/js/` – aplicația
- `docs/parc-data.js` – harta, generată din planul PDF cu `tools/extract_plan.py`
- `docs/test-scanner.html` – pagină simplă pentru verificat citirea codurilor de bare
- `docs/sw.js`, `docs/manifest.webmanifest` – instalare pe telefon și funcționare fără semnal

## Unde rulează

Aplicația e publicată cu GitHub Pages din folderul `docs/` al ramurii `main`:
<https://bogdanpopa74.github.io/parc-tutora-inventar/>. Camera telefonului merge doar pe HTTPS,
deci aplicația trebuie deschisă de la această adresă (sau de pe un domeniu propriu, vezi mai jos).

Pe telefon (Android, Chrome): deschide adresa, apoi Meniu → „Instalează aplicația”. Apare pe ecranul
de pornire ca orice aplicație, pornește pe tot ecranul și merge și fără semnal.

## Date live între telefon și laptop

Fiecare dispozitiv își ține datele local (IndexedDB), ca scanarea să meargă și fără internet.
Cu sincronizarea pornită, dispozitivele citesc și scriu aceleași fișiere dintr-un depozit GitHub
privat, iar ce se scanează pe telefon apare pe laptop în 10–30 de secunde.

Configurare, o singură dată:

1. Creează pe GitHub un depozit **privat**, de exemplu `parc-tutora-date`, cu „Add a README” bifat.
2. Creează un token: <https://github.com/settings/personal-access-tokens/new> → „Only select
   repositories” → depozitul de date → Repository permissions → **Contents: Read and write**.
3. Pe laptop: Meniu → „Pornește sincronizarea” → scrie depozitul (`utilizator/parc-tutora-date`),
   tokenul și un nume pentru dispozitiv → „Conectează cu token”.
4. Tot acolo: „Copiază linkul pentru alt dispozitiv”. Trimite linkul pe fiecare telefon (WhatsApp,
   e-mail); la deschidere, telefonul se conectează singur. Linkul conține tokenul, deci se dă doar
   oamenilor care scanează.

În depozitul de date apar: `date/R01.json … R21.json` (seriile, câte un fișier pe rând de mese),
`date/echipamente.json` (fișe, legături masă → invertor) și `fisiere/` (PDF-uri și poze atașate,
până la 25 MB fiecare). Fiecare trimitere e un commit cu numele dispozitivului, deci există istoric.

Reguli de unire: pentru fiecare panou sau fișă câștigă modificarea cea mai recentă (după ceasul
dispozitivului). Dacă două telefoane scanează aceeași serie pe panouri diferite, ambele rămân și
apar la „Serii duble” în tabelul cu date.

Limite: gândit pentru câteva dispozitive (GitHub limitează numărul de scrieri pe oră; aplicația
trimite cel mult o dată la 15 secunde și reia singură dacă e oprită temporar).

## Verificare pe laptop

- Harta se actualizează singură. „Progres” arată ce e scanat, „Invertoare” colorează mesele după invertor.
- Butonul ▦ din bara de sus deschide tabelul cu date: toate panourile, cu filtre (rând, invertor,
  scanate / nescanate / dubluri), cine a scanat și când. Un clic pe rând duce la panou pe hartă.
- Meniu → „Folder pe calculator” (Chrome/Edge): aplicația scrie automat într-un folder ales
  `Inventar parc.xlsx`, `inventar-parc.json` și fișierele atașate, în `Echipamente/<nume>/`.
- Meniu → „Descarcă Excel” pentru un export pe loc.

## Domeniu propriu

1. În acest depozit: Settings → Pages → „Custom domain” → scrie domeniul (ex. `parc.exemplu.ro`) → Save.
2. La firma de la care ai luat domeniul: pentru un subdomeniu, o înregistrare `CNAME` către
   `bogdanpopa74.github.io`; pentru domeniul gol, patru înregistrări `A` către 185.199.108.153,
   185.199.109.153, 185.199.110.153 și 185.199.111.153.
3. După ce GitHub confirmă domeniul, bifează „Enforce HTTPS”.

GitHub adaugă singur fișierul `docs/CNAME`; nu îl șterge. Pe adresa nouă browserul pornește cu
date goale (stocarea e separată pe fiecare adresă), deci conectează sincronizarea înainte de mutare:
datele se descarcă singure din depozit.

## Paleți și clasele modulelor

`docs/paleti-data.js` vine din „Lista_4752module_pe_paleti” (4752 de module, 144 de paleți × 33):
`python3 tools/build_paleti.py Lista_4752module_pe_paleti_rev01.xlsx docs/paleti-data.js`.

La fiecare scanare aplicația arată clasa modulului (720L / 715L / 710L / 710H = puterea și intensitatea:
L curent mic, H curent mare), paletul și ce conține paletul. Avertizează la module sparte (paletul 0332),
la serii care nu sunt în listă și când pe aceeași masă (același string) ajung clase diferite.
Se pot tasta și doar ultimele 6 cifre ale seriei. Harta are modul „Clase”, iar tabelul cu date are fila
„Paleți” (montate / rămase) și filtrul „De verificat”; Excelul are foaia „Paleți”.

## Harta și legăturile electrice

`tools/extract_plan.py` citește planul exportat din DWG (PDF vectorial): 4536 de panouri în 162 de
mese (2 × 14) pe 21 de rânduri, 9 invertoare, PTAB, stâlpii de racord și 18 stâlpi de iluminat/video.
Legătura masă → invertor vine din planșa de cabluri DC: coborârea de cablu a fiecărei mese e desenată
la marginea ei din stânga, deci atribuirea e fără echivoc (18 stringuri pe invertor). Lungimile de
cablu din „jurnalele de cablu” sunt trecute în fișele invertoarelor, la „Din plan”.

Ce nu este în plan și se completează în aplicație: seriile, modelele reale, care invertor are ce
putere, numerotarea intrărilor (stringul 1–18 e pus în ordinea rândurilor), bateriile. Dacă în teren
legăturile diferă, se corectează din fișa invertorului („Alege pe hartă mesele acestui invertor”)
sau din fișa mesei.

Regenerare:

    pip install pdfplumber
    python3 tools/extract_plan.py plan.pdf docs/parc-data.js

## Probă locală pe calculator

    python3 -m http.server 8000 --directory docs      # apoi http://localhost:8000
