# Проверка готовности к Vercel Preview

Код готов к первому ограниченному тесту после ручной настройки изолированной
среды. Само окружение Vercel, его переменные, IAM и CORS из репозитория не видны,
поэтому готовность облачной конфигурации пока не подтверждена.
Приложение не публиковалось, production Rules не менялись, миграция не запускалась.

## Что проверено локально

| Проверка | Результат |
| --- | --- |
| `npm.cmd run test:rules` с Java 21 и локальным demo-проектом | См. свежие результаты в [production-release.md](production-release.md) |
| `npm.cmd test -- --watchAll=false --runInBand` | 108 тестов прошли |
| `npm.cmd run test:server` | 25 тестов прошли |
| `npm.cmd run build` | Сборка успешна |
| Все клиентские поля создания/обновления против Rules | Совместимы, включая `replanted` |
| Чужие документы, изменение владельца и служебных полей | Запрещены в Rules и тестах |
| Создание/замена/окончательное удаление через серверный сервис | Проверены с реальным Admin SDK и Firestore Emulator; S3 — заглушка |
| Старые base64-фото | `photo` отображается без API/S3; обычные правки его не меняют |

Полная сверка полей: [firestore-rules-audit.md](firestore-rules-audit.md).

## Корзина и восстановление

В текущей новой версии перемещение в корзину обновляет `deletedAt`, `hidden`,
`pinned`, восстановление — `deletedAt`. Правила это разрешают владельцу и не
трогают файлы. Автоочистки старых записей больше нет.

Окончательное удаление из браузера запрещено Rules, кнопка обращается к API.
При `ENABLE_PERMANENT_PLANT_DELETE=false` или отсутствии этой переменной API
возвращает понятное сообщение и сохраняет растение в корзине. Это намеренно.
В первом релизе есть дополнительная блокировка удаления в коде API, даже при
ошибочном env `true`. Внутренний сервис удаления сначала блокирует запись,
удаляет файлы и только потом документ. Пока `_photoDeleting: true`, восстановление запрещено, поскольку
часть файлов уже могла быть удалена; повтор удаления продолжает операцию.

Совместимость относится к текущему обновлённому коду. В исходной версии из Git
ещё были клиентские записи `photo`, прямой `deleteDoc` и автоочистка корзины.
Если именно такая версия сейчас работает в production или старой вкладке,
итоговые правила заблокируют создание и изменение base64-фото и удаление.
Для production подготовлены [переходные Rules](../firestore.transition.rules)
и [порядок выпуска](production-release.md). Не применяйте новые production Rules
для теста Preview. Переход production-клиента и правил позже нужно согласовать;
открытые старые вкладки следует обновить.

## Изоляция Firebase обязательна

Vercel Preview изолирует публикацию приложения, но не сервисы, выбранные
переменными окружения. Если `REACT_APP_FIREBASE_PROJECT_ID` и
`FIREBASE_PROJECT_ID` указывают на production, действия в Preview идут в
production Firestore/Auth. В проекте нет отдельного переключателя Preview-базы.

Чтобы проверить опубликованный Preview с новыми Rules, нужен отдельный
тестовый Firebase-проект. Его web-конфигурацию и Admin-учётные данные задают
**только в Preview**; правила применяют только в этом тестовом проекте.
Реальные документы и base64-фотографии туда копировать не требуется: создайте
одно тестовое растение, а совместимость legacy-данных уже проверяется на
искусственных данных в локальных тестах. В этой задаче облачные проекты и
дополнительные платные ресурсы не создавались.

Если отдельного тестового проекта нет, сначала используйте локальные тесты:

```powershell
# В PATH должна быть Java 21 или новее.
npm.cmd run test:rules
```

Эта команда явно выбирает `demo-ficus-diary-rules`, загружает `firestore.rules`
в локальный эмулятор, выполняет тесты и останавливает его. Она не публикует
правила, не читает `.env.local` и не использует настоящие учётные данные Firebase.
Обычный `npm start`/`vercel dev`/Preview автоматически к эмулятору не подключается.
Vercel Function также не может обращаться к эмулятору на вашем `localhost`.

## Настройки первого Preview

| Настройка | Что проверить вручную |
| --- | --- |
| Framework / build / output | Create React App, `npm run build`, `build` |
| Node.js | `24.x`, как в `package.json` |
| Серверная функция | `api/photos.js` → `/api/photos`, Node runtime, `maxDuration: 60`; SPA rewrite исключает `/api/` |
| Публичные переменные | Все `REACT_APP_FIREBASE_*` из `.env.example`, web app тестового Firebase-проекта |
| Firebase Admin | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`; тот же тестовый проект |
| Yandex | `YANDEX_ACCESS_KEY_ID`, `YANDEX_SECRET_ACCESS_KEY`, `YANDEX_BUCKET_NAME`, `YANDEX_S3_ENDPOINT` |
| Защита удаления | `ENABLE_PERMANENT_PLANT_DELETE=false` |
| Scope переменных | Именно Preview; проверить переопределения конкретной ветки |
| Секреты | Без префикса `REACT_APP_`; PEM с переносами или `\n`; нет emulator-переменных в Preview |
| Права | Admin может читать/писать тестовый Firestore и читать Firebase Auth; Yandex имеет необходимые права только на заданный приватный бакет |
| CORS | Точный HTTPS origin выбранного Preview в бакете; PUT/GET/HEAD и `content-type` по [инструкции](object-storage.md#2-cors-бакета--вручную) |
| Firebase Auth | Email/Password включён в тестовом проекте; проверить домен Preview и ограничения web API key, если настроены |

Node.js 24 поддерживается Vercel, каталог `api/` соответствует размещению
Node-функций; AWS SDK, Firebase Admin и Sharp находятся в серверных зависимостях.
Загрузка файлов идёт напрямую в S3, а API принимает небольшой JSON; фото не
проходит через лимит тела запроса Vercel Function. Серверные модули не импортируются
браузерным кодом. Изменение env требует новой сборки/Preview.

## Исправление загрузки `/api/photos` на Node.js 24 (20 ноября 2026)

В `package-lock.json`: `firebase-admin@14.5.1` → `jwks-rsa@4.1.0` →
`jose@6.2.18`. Это также последние версии по npm Registry на дату проверки.
`jwks-rsa` синхронно требует ESM-модуль `jose` в `src/utils.js` и
`src/integrations/passport.js`; второй модуль тоже загружается при импорте
`firebase-admin/auth`. При отключённом `require(esm)` функция падает ещё до
обработки запроса. Обычный локальный запуск Node.js 24 скрывал эту проблему.
Замена только импорта в приложении не исправляет внутренний `require('jose')`.

`patches/jwks-rsa+4.1.0.patch` заменяет оба импорта на динамический `import()`
внутри асинхронных операций. `patch-package@8.0.1` применяет патч автоматически
через `postinstall`, в том числе при `npm ci`; ручные правки `node_modules` не
нужны. Ошибка применения останавливает установку (`--error-on-fail`). Scoped
override фиксирует `jwks-rsa@4.1.0` для Firebase Admin, чтобы обновление зависимости
не оставило этот патч незаметно несовместимым. При переходе на upstream-исправление
нужно удалить патч и override и повторить runtime-тесты. Установка с
`--ignore-scripts` несовместима с этим исправлением; в Build Logs должна быть
строка `jwks-rsa@4.1.0 ✔`.

Отката библиотек нет: `jose` 6 остаётся поддерживаемой веткой; версия 5 прекратила
получать исправления безопасности 30 апреля 2026 года. Полная пересборка сторонних
модулей добавляла бы отдельный этап сборки и больший объём изменений, поэтому здесь
используется узкий воспроизводимый патч загрузчика. `npm audit --omit=dev` до и
после изменения показывает те же 50 находок (9 low, 8 moderate, 32 high, 1 critical).
Для `firebase-admin`, `jwks-rsa`, `jose`, `patch-package` и прямых зависимостей
инструмента патча находок нет; общий audit проекта не является чистым.

`npm.cmd run test:server` теперь всегда отключает `require(esm)`. Новый
`tests/server/runtime.test.cjs` дополнительно создаёт чистый production-процесс
Node.js 24 с `VERCEL_ENV=preview` без унаследованных облачных секретов и загружает
реальный `api/photos.js` до установки заглушек. Шесть внутренних сценариев
проверяют холодный старт, Firebase ID Token с настоящей RSA-подписью, отказ при
неверной подписи/claims/алгоритме/сроке, отзыв токена, отключённого пользователя,
преобразование JWK через `jose` и callback-интеграцию Passport. Проверка токена
и `verifyIdToken(token, true)` выполняются настоящим SDK; заменены только HTTP-
ответы и получение OAuth access token. Firestore и S3 не читаются и не изменяются.

Проверки: 26 серверных тестов (включая 6 сценариев в дочернем процессе),
108 клиентских тестов, production build — успешно. Локальная платформа Windows;
Linux-упаковку и фактический деплой Vercel эта проверка не заменяет.

Чтобы обновить Preview исходниками из локальной `feature/yandex-storage`,
в корне проекта, уже связанного с нужным Vercel-проектом, выполнить:

```powershell
npx vercel deploy --environment=preview --force --meta githubDeployment=1 --meta githubCommitRef=feature/yandex-storage
```

`--force` исключает старый build cache, а metadata сохраняет привязку к ветке для
её Preview env. Команда создаёт новый Preview из локальных файлов и не требует
`git push`. Она не выполнялась в рамках исправления.

Источники: [исходник jwks-rsa](https://github.com/auth0/node-jwks-rsa/blob/master/src/utils.js),
[поддерживаемые версии jose](https://github.com/panva/jose/security),
[завершение поддержки jose 5](https://github.com/panva/jose/discussions/790),
[параметры Vercel deploy](https://vercel.com/docs/cli/deploy).

## Что ещё не подтверждено

- Реальные значения и scope переменных в Vercel, выбранный Firebase-проект.
- Linux-упаковка Sharp и фактический запуск `/api/photos` в Vercel: локальный
  CRA build проверяет браузерную сборку, а не сборку Vercel Functions.
- Доступ из Vercel к Firebase/Yandex, права сервисных аккаунтов, CORS бакета.
- Полный сценарий в браузере на размещённом Preview, включая S3 PUT/GET.

После ручной настройки проверьте **одно новое тестовое растение**: создать с
фото, обновить страницу, заменить фото, переместить в корзину и восстановить.
Повторите сохранение после сетевой ошибки и проверьте отказ чужому аккаунту.
Окончательное удаление на первом тесте оставьте выключенным.

Официальные источники:
[Node.js в Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions),
[Node Functions](https://vercel.com/docs/functions/runtimes/node-js),
[Preview env](https://vercel.com/docs/environment-variables),
[изолированные demo-проекты Emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore).
