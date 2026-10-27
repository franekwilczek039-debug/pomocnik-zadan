# ✨ Pomocnik Zadań AI — wtyczka do Chrome

Odczytuje zadanie z otwartej strony, rozwiązuje je przy pomocy Claude i daje gotową odpowiedź do skopiowania albo wstawienia w pole na stronie, z wyjaśnieniem krok po kroku.

## ⬇️ [Pobierz wtyczkę (ZIP)](https://github.com/franekwilczek039-debug/pomocnik-zadan/raw/main/pomocnik-zadan.zip)

## Instalacja

1. Pobierz [`pomocnik-zadan.zip`](https://github.com/franekwilczek039-debug/pomocnik-zadan/raw/main/pomocnik-zadan.zip) i rozpakuj go do folderu.
2. W Chrome wejdź na `chrome://extensions`.
3. Włącz **Tryb programisty** (prawy górny róg).
4. Kliknij **Załaduj rozpakowane** i wskaż rozpakowany folder.
5. Przypnij ikonkę wtyczki (puzzel na pasku → pinezka).

Działa też w Edge, Brave i Operze (strony `edge://extensions` itd.).

## Klucz API (każdy ma własny)

Wtyczka nie zawiera żadnego konta ani klucza. Każdy wpisuje swój:

1. Załóż konto na <https://console.anthropic.com> i doładuj saldo (Billing).
2. W **API Keys** utwórz klucz (`sk-ant-...`).
3. Kliknij ikonkę wtyczki → ⚙️ → wklej klucz → **Zapisz**.

Klucz zostaje tylko w Twojej przeglądarce i jest wysyłany wyłącznie do API Anthropic. Koszt jednego zadania to zwykle ułamek centa do kilku centów; panel pokazuje szacunek. Model Haiku jest najtańszy, Opus najdokładniejszy.

## Jak używać

1. Otwórz stronę z zadaniem i kliknij ikonkę wtyczki — otworzy się panel boczny.
2. (Opcjonalnie) zaznacz myszką samo polecenie — wtyczka weźmie wtedy tylko ten fragment.
3. Przy rysunkach, wykresach i wzorach zaznacz **Dołącz zrzut ekranu**.
4. Kliknij **Rozwiąż zadanie z tej strony**.
5. **Kopiuj** albo kliknij w pole na stronie, a potem **Wstaw w pole**.
6. W polu **Dopytaj** możesz poprosić o wyjaśnienie, skrócenie, poprawkę.

## Dla programistów

Kod panelu jest w `src/panel.js` (oficjalne SDK `@anthropic-ai/sdk`). Po zmianach:

```bash
npm install
npm run build   # buduje extension/panel.js
npm run zip     # tworzy pomocnik-zadan.zip
```
