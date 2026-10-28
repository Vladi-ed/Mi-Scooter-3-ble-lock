# Источники и лицензия

## NinebotCrypto / ScooterHacking

Криптографический протокол в `js/crypto.js` адаптирован на JavaScript
для Mi3 BLE на основе открытой реализации и материалов сообщества ScooterHacking:

- [NinebotCrypto](https://github.com/scooterhacking/NinebotCrypto)
- [Описание протокола](https://github.com/scooterhacking/NinebotCrypto/blob/master/README.md)
- [Лицензия исходного проекта: GNU AGPL v3](https://github.com/scooterhacking/NinebotCrypto/blob/master/LICENSE)

В исходном проекте отмечен вклад majsi в описание протокола.
Адаптация Mi3 BLE включает JavaScript-реализацию, обработку обмена ключами
и интеграцию с Web Bluetooth. Дата текущих изменений: 25 октября 2026 года.
Это отдельный проект; он не является официальным продуктом ScooterHacking.

Лицензия Mi3 BLE — AGPL-3.0-only; полный текст находится в [LICENSE](LICENSE).
Уведомления об источниках следует сохранять при распространении.

## Криптографические примитивы

`js/aes.js` реализует AES-128 по FIPS-197; `js/sha1.js` — SHA-1 по RFC 3174.
Внешние production-зависимости не используются.
