# GPV Weather Atlas

RustFS の `weather/noaa-gfs/YYYYMMDDHH.zarr` と `weather/forecast/YYYYMMDDHH.zarr` に
保存された NOAA/NCEP GFS 0.25° Zarr v2 を、
日本周辺の国土地理院地図上に表示する Bun + TypeScript アプリです。

## 表示方法と投影

GFS は緯度・経度による規則格子ですが、地理院タイルは Web Mercator です。
本アプリは Zarr の格子を単純な画像として重ねず、各格子セルの緯度・経度境界を
Leaflet の地図座標へ変換してから Canvas に描画します。表示範囲は 20–50°N、
118–155°E で、元データの0.25°間隔を維持し、121×149点を表示します。
通信には8bitグレースケールPNGを使用し、系列・要素の切り替えでページを再読み込みしません。

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

## API

- `GET /weather-viewer/api/catalog`: `_SUCCESS` があるZarrのサイクル・予報時刻・要素IDと、各系列のメタデータrevisionを列挙
- `GET /weather-viewer/api/metadata?collection=…&revision=…`: 系列ごとに格子座標と全要素の情報をまとめたJSON
- `GET /weather-viewer/api/grid.png?dataset=…&variable=…&time=…&revision=…`: 指定した要素・時刻の日本周辺格子をPNGで返却（幅149×高さ121）
- `GET /weather-viewer/healthz`: プロセスのヘルスチェック

RustFS のアクセスキーはサーバー内だけで使用され、API やブラウザには返しません。


### PNGと量子化の契約（version 1）

1画素が元データの1格子点です。上から北→南、左から西→東で、再投影前の経緯度格子を
転送します。ブラウザは `createImageBitmap` と原寸Canvasで画素を読み取り、各セルの
経緯度境界をWeb Mercatorへ投影して描画します。画像全体を長方形に引き伸ばしません。

値は表示単位へ変換後、`Math.floor`で整数へ切り捨てて範囲内へクランプします。
例えば−1.2℃は−2℃になります。画素値は `整数値 − offset`、復元値は `画素値 + offset` です。
255は欠測専用で、NaN・無限大・数値型のZarr fill_valueも255へ変換します。
格納範囲と配色範囲は別です。カーソルの値は整数化・頭打ち後の値を表示します。

| 要素 | 格納範囲 | offset | 刻み |
|---|---|---:|---:|
| 気温 | −80～60℃ | −80 | 1℃ |
| 海面気圧 | 850～1,104hPa | 850 | 1hPa |
| 東西風・南北風 | −127～127m/s | −127 | 1m/s |
| 相対湿度・雲量 | 0～100% | 0 | 1ポイント |
| 降水量 | 0～254mm | 0 | 1mm |

1mm未満の降水は0mmとなります。PNGは不透明・8bitグレースケール・非インターレースで、
色補正や向きのメタデータを含めません。ブラウザは未知のプロトコル、要素、量子化設定、
格子座標、PNGのサイズ・画素形式をエラーとして扱います。

### メタデータとキャッシュ

要素の説明・配色・量子化設定・格子座標は系列ごとに1つのJSONへ集約します。
ブラウザ起動時に各系列のJSONを1回取得し、要素・時刻・初期時刻の切り替えでは再取得しません。
カタログは全要素の説明を繰り返さず、各データセットの要素IDのみを持ちます。

JSON内容のSHA-256をrevisionとしてURLへ含め、PNGにも同じrevisionを指定します。
メタデータとPNGの成功応答は `Cache-Control: private, max-age=31536000, immutable`（1年間）、
エラー応答は `no-store`です。新サイクルが追加されるカタログ一覧のみ、HTTP・サーバー内ともに
5分キャッシュします。新サイクルを一覧へ反映するには5分経過後に画面を開き直してください。
公開済みの同じZarrパスは上書きしない運用が前提です。通信契約を変更する際はversionを更新してください。

サーバーは生成PNGを最大256件、系列メタデータ生成結果を最大64件保持します。
ブラウザは復元済み格子を最大128件保持し、直近の予報へ戻るとネットワーク通信なしで表示します。
上限までのデータに時間による失効はなく、必要時に古いものから退避します。
PNGリクエストの切り替え時には旧リクエストを中止し、古い結果を新しい表示へ適用しません。
3 Podのサーバー内キャッシュは共有されません。

### 転送処理の検証

```sh
bun test
bun run check
bun run build
```

テストは合成データのS3互換HTTP応答を使い、系列別メタデータ、PNGのCRC・画素値、
整数化・欠測・クランプ、原密度の格子、パディングされたZarr端チャンク、APIキャッシュ、
未知の入力の拒否を確認します。RustFS実データの検証を代替するものではありません。
