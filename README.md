# Inventar parc fotovoltaic Țuțora

Aplicație web (fără server, fără pas de build) pentru inventarul parcului: harta cu toate mesele și
panourile, scanarea seriilor cu telefonul și fișe pentru PTAB/STS, invertoare, stâlpi și alte echipamente.

- `docs/index.html`, `docs/app.css`, `docs/js/` – aplicația
- `docs/parc-data.js` – harta, generată din planul PDF cu `tools/extract_plan.py`
- `docs/test-scanner.html` – pagină simplă pentru verificat citirea codurilor de bare
- `docs/sw.js`, `docs/manifest.webmanifest` – instalare pe telefon și funcționare fără semnal

## Pornire

Camera telefonului merge doar pe HTTPS. Cel mai simplu: GitHub Pages, Settings → Pages →
„Deploy from a branch” → branch-ul `main`, folderul `/docs`. Local, pentru probă pe calculator:

    python3 -m http.server 8000 --directory docs      # apoi http://localhost:8000

## Unde stau datele

Seriile și fișele se păstrează în browser, pe dispozitivul pe care lucrezi (IndexedDB).
Pe calculator, din Meniu → „Folder pe calculator”, aplicația scrie automat într-un folder ales:
`Inventar parc.xlsx`, `inventar-parc.json` și fișierele atașate, în `Echipamente/<nume>/`.
De pe telefon, datele se trimit cu Meniu → „Trimite datele” și se importă pe calculator.

## Regenerarea hărții

    pip install pdfplumber
    python3 tools/extract_plan.py plan.pdf docs/parc-data.js
