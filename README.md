# デジプル 勤務時間管理システム（Railway + PostgreSQL）

出退勤の打刻、残業・休暇などの申請と承認、月次の確定・締め、36協定のチェック、勤務表兼残業表（Excel・PDF）の作成を行うウェブアプリです。

Google Apps Script 版の業務ロジック（`core/`）をそのまま使い、データを PostgreSQL に、画面・定時処理・メール・帳票を Railway 上の Node.js サーバーに移しています。

## 構成

| 場所 | 中身 |
|---|---|
| `core/` | 業務ロジック（計算・申請・承認・締め・通知）。GAS 版と同じ同期コードで、`server/engine.js` が vm の中で動かす |
| `server/index.js` | Express。Google ログイン、`POST /api/関数名`、ファイルのダウンロード、全データの Excel 出力・取り込み |
| `server/engine.js` | core の実行環境。処理を1件ずつ順に実行し、変更を1トランザクションで DB に書く。エラー時は巻き戻す |
| `server/store.js` | PostgreSQL。テーブルと列は `core/schema.js` から起動時に自動作成・追加。advisory lock で書き込み担当を1つに限る |
| `server/forms.js` | 帳票。`template/form_template.xlsx` に転記し、LibreOffice で数式を計算させて照合、PDF（A4横2枚／人）を作る |
| `server/mail.js` | 通知メール。管理者が画面から接続した Google アカウントの Gmail API で送る（SMTP も可） |
| `server/jobs.js` | 夜間処理（毎日 2:10）・朝の通知（設定 `notify_hour` 時台）。同じ日に2回は動かない |
| `public/` | 画面（GAS 版の HTML。`google.script.run` を fetch に置き換えるだけ） |

データは PostgreSQL の普通のテーブルです（`employees`、`punch_log`、`requests`、`daily`、`monthly` など。型つき）。管理画面の『全データをダウンロード』で全テーブルを1つの Excel にでき、DB には SQL で直接つなげます。

## Railway の構成

| サービス | 内容 |
|---|---|
| `Postgres` | Railway の PostgreSQL テンプレート |
| `kintai` | このリポジトリ（Dockerfile でビルド）。レプリカは1つ（`railway.json`） |

### kintai の環境変数

| 変数 | 値 |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SESSION_SECRET` | 32文字以上のランダムな文字列（変えると全員ログアウトし、メール送信の接続もやり直し） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud の OAuth クライアント（下記） |
| `ALLOWED_DOMAINS` | `g.takayoshi.co.jp`（ログインを許すメールのドメイン） |
| `ADMIN_EMAILS` | 初期移行の担当者（社員マスタが空でもデータ取り込み画面に入れる） |
| `MAIL_FROM_NAME` | 差出人名 |
| `PORT` | `3000` |
| `APP_URL` | 独自ドメインにする場合だけ。未設定なら Railway のドメイン |

## Google ログインの設定（Google Cloud Console）

1. Google Cloud でプロジェクトを作る（または既存のものを使う）
2. 『API とサービス』→『OAuth 同意画面』：ユーザーの種類は **内部**、アプリ名『デジプル勤怠』
3. 『API とサービス』→『ライブラリ』で **Gmail API** を有効にする（通知メールを Gmail で送るため）
4. 『認証情報』→『認証情報を作成』→『OAuth クライアント ID』→ 種類『ウェブアプリケーション』
   - 承認済みのリダイレクト URI：`https://（公開URL）/auth/callback`
5. 表示されたクライアント ID とシークレットを Railway の `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` に入れる

## 旧スプレッドシートからの移行

1. 旧『デジプル勤怠データ』を『ファイル』→『ダウンロード』→『Microsoft Excel（.xlsx）』で保存する
2. 新しい勤怠の画面に `ADMIN_EMAILS` のアカウントでログインし、`/admin/import` を開いてファイルを取り込む
   - シート名＝テーブル名のシートを取り込み、ファイルに含まれるテーブルは置き換える
   - `daily`・`monthly` は夜間処理で作り直されるので、取り込まなくても構いません
3. 管理 › マスタ・保守 で社員・設定を確認し、『メール送信』で Google アカウントを接続してテストメールを送る
4. 社員に新しい URL を案内する。旧 GAS 版のトリガーは止める（`installTriggers` で登録した2つを削除）

## 開発

```bash
npm install
npm test                                  # 計算・API・帳票（LibreOffice があれば）・PostgreSQL（TEST_DATABASE_URL があれば）
npm run dev                               # http://localhost:3000 （メモリ保存・開発用ログイン・架空の社員）
DATABASE_URL=postgres://... DEV_LOGIN=1 ADMIN_EMAILS=you@g.takayoshi.co.jp node server/index.js
```

`DEV_LOGIN=1` は `GOOGLE_CLIENT_ID` が未設定のときだけ有効です（本番では無効）。

## 運用メモ

- 書き込みは1インスタンスだけ。デプロイ時は新しいインスタンスが前のインスタンスの終了を待ってからデータを読み込みます（数秒〜数十秒『起動中です』と表示されることがあります）
- 定時処理は `job_runs` テーブルに実行記録が残ります
- 締めの CSV・帳票は `app_files` テーブルに保存し、管理者だけがダウンロードできます
- バックアップ：Railway の Postgres のバックアップ機能、または管理画面の『全データをダウンロード』
