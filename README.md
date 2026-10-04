# GPV Weather Atlas

RustFS の `weather/noaa-gfs/YYYYMMDDHH.zarr` と `weather/forecast/YYYYMMDDHH.zarr` に
保存された NOAA/NCEP GFS 0.25° Zarr v2 を、
日本周辺の国土地理院地図上に表示する Bun + TypeScript アプリです。

## 表示方法と投影

GFS は緯度・経度による規則格子ですが、地理院タイルは Web Mercator です。
本アプリは Zarr の格子を単純な画像として重ねず、各格子セルの緯度・経度境界を
Leaflet の地図座標へ変換してから Canvas に描画します。表示範囲は 20–50°N、
118–155°E で、通信量を抑えるため既定では 0.5°間隔に間引いています。

左右の矢印キーで予報時刻、上下の矢印キーで同じ系列内のモデル初期時刻を変更できます。
初期時刻を変更した場合は同じ予報時間を維持し、存在しなければ最も近い予報時間を選択します。
地図の移動にはマウスまたはタッチ操作を使用します。
気象要素は選択肢に表示される `Alt+1`～`Alt+9` でも切り替えられます。

海面更正気圧は 990–1020 hPa の範囲で、1005 hPa からの差を強調した高コントラスト表示です。

背景地図には国土地理院の[標準地図タイル](https://maps.gsi.go.jp/development/ichiran.html)を使用し、表示画面内に出典を常時表示します。
ズームレベル5～8の小縮尺タイルに関係する GEBCO、海上保安庁、NIMA VMAP0 の出典も
フッターへ記載しています。

## ローカル実行

必要な環境変数を設定してから実行します。認証情報は `.env` やリポジトリへ保存しないでください。

```sh
bun install --frozen-lockfile
S3_ENDPOINT_URL=http://127.0.0.1:19000 \
S3_BUCKET=weather \
S3_PREFIXES=noaa-gfs,forecast \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
bun run dev
```

インデックスは `http://localhost:3000/weather-viewer`、気象地図は
`http://localhost:3000/weather-viewer/map`、ヘルスチェックは `/weather-viewer/healthz` です。

気象地図の選択状態は `collection`（データ系列）と `variable`（気象要素）の
クエリパラメータへ反映されるため、そのまま共有用リンクとして利用できます。

## コンテナと Kubernetes

`.github/workflows/publish-image.yml` は main への push（PR の merge を含む）ごとに
Dockerfile から `linux/amd64` イメージをビルドし、GHCR へ公開します。
PR ではビルドのみを検証し、イメージを公開しません。main に対する手動実行も可能です。

- `ghcr.io/uiui611/weather-viewer:main`: main の最新ビルド
- `ghcr.io/uiui611/weather-viewer:sha-<40桁のcommit SHA>`: コミットごとのイメージ

認証には GitHub が自動発行する `GITHUB_TOKEN` と workflow 内の `packages: write` を使います。
PAT や追加の repository secret は不要です。第三者 Actions は固定 commit SHA で参照します。

### GitHub で必要な設定

1. Repository の **Settings → Actions → General** で Actions を有効にします。
   利用制限がある場合は `actions/checkout` と workflow で参照する `docker/*` Actions を許可してください。
   token の既定権限は read-only のままで構いません。publish job が必要な権限だけを指定します。
2. この変更を main へ merge し、**Actions → Build, publish and deploy container image** の成功を確認します。
3. 初回公開後、アカウントの **Packages → weather-viewer → Package settings** で
   **Change visibility → Public** にします。リポジトリが public でも、初回の GHCR package は
   private が既定です。このマニフェストは匿名 pull を前提とし、`imagePullSecrets` を指定しません。
4. 同名 package がすでにある場合は、接続先 repository が `uiui611/weather-viewer` であり、
   **Manage Actions access** でこの repository に Write 権限があることを確認します。
   workflow の OCI source label により、新規 package は repository に関連付けられます。

仕様: [GHCR の公開範囲と認証](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### Kubernetes への適用と更新

各 worker ノードから `ghcr.io` とイメージ配信先への HTTPS 通信が必要です。
package を Public に設定した後、匿名 pull を確認してからマニフェストを適用します。

```sh
docker pull ghcr.io/uiui611/weather-viewer:main
kubectl apply --dry-run=client -f weather-viewer.yaml
kubectl apply -f weather-viewer.yaml
kubectl rollout status deployment/weather-zarr-viewer -n default --timeout=180s
```

マニフェストは更新される `main` タグを使い、`imagePullPolicy: Always` で Pod 作成時に取得します。
Actions はイメージ公開後、OIDC 認証付き webhook で Deployment の更新を要求します。
通知に失敗してもイメージ公開と workflow は成功扱いとし、警告を記録します。Pod の起動完了は待ちません。手動で再更新する場合は、
以下を実行してください。

```sh
kubectl rollout restart deployment/weather-zarr-viewer -n default
kubectl rollout status deployment/weather-zarr-viewer -n default --timeout=180s
```

再現性や確実なロールバックが必要な運用では、`image` を `sha-<40桁のcommit SHA>` タグまたは
`ghcr.io/uiui611/weather-viewer@sha256:<digest>` に固定してから適用してください。
`main` タグのままでは過去の ReplicaSet も同じタグを参照するため、過去のイメージへ戻すには
そのビルドの SHA タグまたは digest を明示する必要があります。

外部 Nginx から公開する場合は URL prefix を削除せず転送します。

```nginx
upstream weather_zarr_viewer {
    server 192.168.101.11:30810;
    server 192.168.101.12:30810;
    server 192.168.101.13:30810;
}

location /weather-viewer/ {
    proxy_pass http://weather_zarr_viewer;
}
```

### 自動更新 webhook の準備

main のイメージ公開後に `https://deploy.mizu-mizu.info/v1/deployments` へ通知します。
認証には GitHub OIDC を使い、publish job に `id-token: write` を指定します。
SSH 秘密鍵、管理者 kubeconfig、共有 webhook secret を GitHub に登録する必要はありません。
受信側はこのリポジトリの main と `.github/workflows/publish-image.yml` を許可します。

最初の通知前に、VPS の TLS 証明書、Ubuntu の受信サービス、専用 Kubernetes 認証情報と
RBAC を用意し、Deployment を GHCR の main と Always に切り替えてください。
受信側の設定は Ubuntu の `/home/mizu/containers/deployment-webhook/README.md` で管理します。
通知は公開後に一度だけ送信し、HTTP 2xx を成功扱いとします。認証とリクエスト内容の検証は
受信側に任せ、応答本文や Pod の起動状態は確認しません。通知失敗は警告となり、workflow を失敗させません。
更新が必要な場合は受信サービスのログを確認して手動で更新するか、最新 main の Actions を再実行します。
再実行でもそのコミットのイメージを `main` タグへ公開するため、最新 main の実行を選んでください。
通知のテストは `node --test .github/scripts/notify-deployment.test.mjs` で実行できます。

## API

- `GET /weather-viewer/api/catalog`: 設定した各系列から `_SUCCESS` がある Zarr と変数・予報時刻を列挙
- `GET /weather-viewer/api/grid`: 指定した変数・時刻の日本周辺格子を返却
- `GET /weather-viewer/healthz`: プロセスのヘルスチェック

RustFS のアクセスキーはサーバー内だけで使用され、API やブラウザには返しません。
