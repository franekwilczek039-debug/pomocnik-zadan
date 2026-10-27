# ✨ Pomocnik Zadań AI — wtyczka do Chrome

Odczytuje zadanie z otwartej strony i przygotowuje gotową odpowiedź do skopiowania albo wstawienia w pole na stronie, z wyjaśnieniem krok po kroku. **Może działać całkowicie za darmo.**

## ⬇️ [Pobierz wtyczkę (ZIP)](https://github.com/franekwilczek039-debug/pomocnik-zadan/raw/main/pomocnik-zadan.zip)

## Instalacja

1. Pobierz [`pomocnik-zadan.zip`](https://github.com/franekwilczek039-debug/pomocnik-zadan/raw/main/pomocnik-zadan.zip) i rozpakuj go (Windows: prawy przycisk → „Wyodrębnij wszystkie”; Mac: kliknij dwa razy).
2. W Chrome wejdź na `chrome://extensions`.
3. Włącz **Tryb programisty** (prawy górny róg).
4. Kliknij **Załaduj rozpakowane** i wskaż rozpakowany folder (ten, w którym jest `manifest.json`).
5. Przypnij ikonkę wtyczki (puzzel na pasku → pinezka). Nie usuwaj folderu — Chrome z niego korzysta.

Działa też w Edge, Brave i Operze.

## Silnik AI — wybierz w ustawieniach (⚙️)

| Silnik | Cena | Co trzeba |
|---|---|---|
| **Gemini (Google)** — domyślny | **za darmo** (dzienny limit) | darmowy klucz z konta Google |
| **Chrome AI** | **za darmo**, bez klucza | mocny komputer: 22 GB wolnego miejsca, karta graficzna >4 GB lub 16 GB RAM; oficjalnie nie zna polskiego, słabszy w matematyce |
| **Claude (Anthropic)** | płatny (ułamek centa – kilka centów za zadanie) | klucz z console.anthropic.com i doładowane saldo |

### Darmowy klucz Gemini (2 minuty)

1. Wejdź na <https://aistudio.google.com/apikey> i zaloguj się kontem Google.
2. Kliknij **Create API key** (Utwórz klucz) i skopiuj go (zaczyna się od `AIza`).
3. Kliknij ikonkę wtyczki → ⚙️ → **Silnik AI: Gemini** → wklej klucz → **Zapisz**.

Gdy skończy się darmowy limit, wtyczka to powie — odczekaj albo wybierz model **Flash-Lite**. W darmowej wersji Google może używać wysłanych treści do ulepszania modeli, więc nie wysyłaj danych osobowych.

Każdy używa własnego klucza. Wtyczka nie zawiera żadnego konta; klucze zostają tylko w Twojej przeglądarce.

## Jak używać

1. Otwórz stronę z zadaniem i kliknij ikonkę wtyczki — otworzy się panel boczny.
2. (Opcjonalnie) zaznacz myszką samo polecenie — wtyczka weźmie wtedy tylko ten fragment.
3. Przy rysunkach, wykresach i wzorach zaznacz **Dołącz zrzut ekranu**.
4. Kliknij **Rozwiąż zadanie z tej strony**.
5. **Kopiuj** albo kliknij w pole na stronie, a potem **Wstaw w pole**.
6. W polu **Dopytaj** możesz poprosić o wyjaśnienie, skrócenie albo poprawkę.

## Dla programistów

Kod panelu jest w `src/panel.js` (oficjalne SDK `@google/genai` i `@anthropic-ai/sdk`, Prompt API Chrome). Po zmianach:

```bash
npm install
npm run build   # buduje extension/panel.js
npm run zip     # tworzy pomocnik-zadan.zip
```
