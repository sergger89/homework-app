# Homework App — репозиторий целиком

Один репозиторий, два готовых к сборке проекта и обе CI-сборки уже на своих местах — просто
положите содержимое этого архива в корень вашего git-репозитория как есть, ничего переносить
и перекладывать не нужно.

```
.
├── .github/workflows/
│   ├── docker-publish.yml   — собирает и публикует Docker-образ веб-приложения в ghcr.io
│   └── android-build.yml    — собирает Android APK (WebView-клиент) на публичных раннерах
├── homework-app/            — веб-приложение (Node.js/Express), см. homework-app/README.md
└── android-client/          — Android-клиент (Kotlin/WebView), см. android-client/README.md
```

## Быстрый старт

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<ваш-логин>/<репозиторий>.git
git push -u origin main
```

После пуша в `main`:
- **`docker-publish.yml`** запустится, только если менялось что-то внутри `homework-app/`, и
  выложит образ в `ghcr.io/<логин>/<репозиторий>:latest`.
- **`android-build.yml`** запустится, только если менялось что-то внутри `android-client/`, и
  положит `app-debug.apk` во вкладку Actions → Artifacts.

Оба workflow также можно запустить вручную (Actions → нужный workflow → Run workflow),
независимо от того, менялись файлы или нет.

Подробности по каждой части — в `homework-app/README.md` и `android-client/README.md`.
