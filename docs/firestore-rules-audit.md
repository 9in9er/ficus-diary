# Совместимость Firestore Rules с ficus-diary

Проверены все рабочие исходники в `src`, `api`, `server`, `scripts`.
Правила не публиковались; production-база и существующие фотографии не менялись.

20.11.2026 действующие Rules прочитаны в Firebase Console; их тестовая копия —
`tests/firestore/fixtures/production-2025-12-10.rules` (не цель публикации).
Добавлены переходные `firestore.transition.rules` и 7 проверок перехода;
общий прогон — 39 тестов. Порядок production-выпуска и ограничения старых
вкладок: [production-release.md](production-release.md).

## Все места записи в plants

| Источник | Операции |
| --- | --- |
| `src/hooks/usePlants.jsx`, `createPlant` | Клиентский `addDoc`: новое растение без фото |
| `src/hooks/usePlants.jsx`, `createWish` | Клиентский `addDoc`: желание без фото |
| `src/hooks/usePlants.jsx`, `updatePlant` | Единственный клиентский `updateDoc`; через него идут все перечисленные ниже изменения |
| `server/photos.cjs`, `commit` | Firebase Admin `runTransaction`: `tx.create` растения/желания с фото или `tx.update` при замене фото |
| `server/photos.cjs`, `delete` | Две Firebase Admin транзакции: `tx.update({_photoDeleting: true})`, затем `tx.delete` после удаления файлов |
| `scripts/migrate-photos.cjs`, `migratePlant` | Отдельная Firebase Admin транзакция с `tx.update({photoKey})`; скрипт автоматически не вызывается |

Клиентских `setDoc`, `deleteDoc`, `runTransaction` и `writeBatch` в рабочем
приложении больше нет. В тестах эти вызовы используются для проверки запретов.
Серверный `.set` в `photos.cjs` относится к `_photoUploads`, а не к `plants`.
`doc(collection(db, 'plants'))` при подготовке загрузки только генерирует ID,
ничего не записывает.

## Поля клиентского создания

| Путь | Точные поля |
| --- | --- |
| Обычное растение, `createPlant` | `name`, `acquiredAt`, `wateringLog`, `fertilizingLog`, `notes`, `userId`, `createdAt`, `pinned`, `hidden`, `deletedAt` |
| Вишлист, `createWish` | `name`, `description`, `price`, `links`, `isWishlisted`, `userId`, `createdAt`, `deletedAt`, `hidden`, `pinned` |

В итоговом `allow create` разрешено объединение этих полей и необязательное
`replanted`. Сейчас `createPlant` и `createWish` его не передают: оно впервые
появляется при переключении пересадки или переносе желания в коллекцию.
Следовательно, отсутствие `replanted` в прежнем `allow create` не блокировало
текущие формы, но асимметрия исправлена для согласованности схемы.
Отсутствие `replanted` по-прежнему разрешено; старые документы обновлять не нужно.

## Все клиентские обновления

| Действие / функция в usePlants | Изменяемые поля |
| --- | --- |
| Редактирование растения, `savePlant` | `name`, `acquiredAt` |
| Редактирование желания, `saveWish` | `name`, `description`, `price`, `links` |
| Полив / удаление полива | `wateringLog` |
| Удобрение / удаление удобрения | `fertilizingLog` |
| Добавление / удаление заметки | `notes` |
| Пересадка, `toggleNeedReplant` | `replanted` |
| Закрепление / открепление | `pinned` |
| Скрытие / показ | `hidden` |
| В корзину, `handleDeletePlant` | `deletedAt`, `hidden`, `pinned` |
| Восстановление, `restorePlant` | `deletedAt` |
| «Уже у меня», `acquireWish` | `isWishlisted`, `acquiredAt`, `createdAt`, `wateringLog`, `fertilizingLog`, `notes`, `pinned`, `hidden`, `replanted`, `deletedAt` |

Поливы и удобрения — массивы ISO-строк. Элемент `notes` содержит `id`, `text`,
`createdAt`; это вложенные данные одного разрешённого поля `notes`, а не
дополнительные поля документа. `links` — массив нормализованных HTTP(S) ссылок.
`createdAt` оставлен разрешённым при update: `acquireWish` обновляет эту дату.
Все реальные поля перечисленных операций присутствуют в `allow update`.

## Серверные операции и фото

При создании с фото сервер записывает обычные поля растения/желания, `userId`,
`isWishlisted`, `createdAt`, `deletedAt`, `hidden`, `pinned` и `photoKey`;
для обычного растения также создаёт `wateringLog`, `fertilizingLog`, `notes`.
Замена фото обновляет `name` и `acquiredAt` либо поля вишлиста, плюс `photoKey`.
Окончательное удаление добавляет `_photoDeleting` и затем удаляет документ.
Миграция добавляет только `photoKey`, сохраняя `photo`.

Эти операции используют **Firebase Admin SDK**, который обходит клиентские
Security Rules. Поэтому добавлять `photoKey`/`_photoDeleting` в клиентские
списки разрешений не нужно. Проверка Firebase ID Token, UID владельца,
ключей объектов, корзины и блокировки удаления находится в `server/photos.cjs`.

При обновлении Rules сравнивают только изменённые поля (`diff().affectedKeys()`),
поэтому уже имеющиеся `photo`, `photoKey` и неизвестные исторические поля не
мешают менять название, поливы и т. п. Они сохраняются без изменений.
Полная перезапись через `setDoc`, удаляющая защищённые поля, запрещена.

## Сохранённые ограничения

- Читать документы и менять разрешённые поля может только их владелец.
  Запрос приложения с `where('userId', '==', uid)` разрешён; чтение всей чужой
  коллекции без ограничения владельца запрещено.
- При создании `userId` должен совпадать с UID текущего пользователя.
  При обновлении он явно должен остаться прежним и исключён из списка изменений.
- Клиент не может добавлять, менять или удалять `photo`, `photoKey`,
  `_photoDeleting`. Нельзя сменить или удалить `userId`.
- `_photoDeleting: true` блокирует клиентские обновления, включая восстановление.
- Клиентский `deleteDoc` всегда запрещён; окончательное удаление идёт через API.
- `_photoUploads`, подколлекции растений и остальные коллекции закрыты.

Новых ограничений типов и обязательных полей не добавлено: это отдельная задача,
которую нужно согласовывать с историческими данными. Удалять неизвестные старые
поля или преобразовывать документы для применения этих правил не требуется.

## Локальные тесты Rules

Добавлены `tests/firestore/plants.rules.test.cjs`, `firebase.rules-test.json`
и dev-зависимости `@firebase/rules-unit-testing` (ветка 5 для Firebase 12),
`firebase-tools`. Нужны Node.js 24 и **Java 21 или новее** в PATH.
Проверьте `java -version`: один `JAVA_HOME` при старой Java в PATH недостаточен
для текущей версии Firebase CLI. Переносимую Java можно выбрать только для
текущего окна PowerShell, не меняя системные настройки:

```powershell
$env:JAVA_HOME = 'C:\path\to\java-21'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
```

```powershell
npm.cmd ci
npm.cmd run test:rules
```

Команда запускает только локальный Firestore Emulator на `127.0.0.1:8080`
с фиктивным project ID `demo-ficus-diary-rules`, выполняет тесты и останавливает
эмулятор. Вход в Firebase, сервисные ключи, `.env.local` и облачные ресурсы не
нужны. При первом запуске Firebase CLI скачивает эмулятор. Production-проект
не выбирается: конфигурация и ID заданы явно в npm-команде. Тесты дополнительно
отказываются работать без локального `FIRESTORE_EMULATOR_HOST` или с другим
`GCLOUD_PROJECT`.

Проверяются создание обоих видов растений, необязательное `replanted`, все
обычные обновления, владелец/чужой пользователь/отсутствие авторизации,
защищённые поля при create/update/merge/full set/transaction/batch, корзина,
блокировка удаления, приватность `_photoUploads`, совместимость старых фото
и редактирования после серверной загрузки.

Отдельный интеграционный тест вызывает **настоящий сервис** `createPhotoService`
с реальным Admin SDK и локальными транзакциями Firestore Emulator: создание
растения и желания с фото, замена фото, окончательное удаление. Вызовы S3 в нём
заменены локальными заглушками; реальный бакет и существующие документы не
затрагиваются.

Официальные основания:
[ограничение изменяемых полей](https://firebase.google.com/docs/firestore/security/rules-fields),
[тестирование Rules в эмуляторе](https://firebase.google.com/docs/firestore/security/test-rules-emulator).
