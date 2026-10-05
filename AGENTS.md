# Weather Viewer エージェント引継ぎ書

## プロジェクトの目的

RustFS の `weather` バケットに保存された NOAA/NCEP GFS 0.25° Zarr v2 を読み取り、
日本周辺を国土地理院の標準地図上へ表示するプライベート LAN 向け Web アプリです。
アプリ本体、コンテナ定義、Kubernetes マニフェストをこのリポジトリだけで再現できる状態を
維持してください。

## 技術構成

- Runtime: Bun 1.3.14
- Language: TypeScript
- Server/API: `Bun.serve`
- Object storage: RustFS の S3互換API、AWS SDK for JavaScript v3
- Zarr decoder: `numcodecs`（Blosc/ZstandardおよびBlosc/LZ4）
- Map/UI: Leaflet、Canvas overlay
- Container base: `oven/bun:1.3.14-alpine`
- Kubernetes Namespace: `default`

主要ファイル:

- `src/server.ts`: HTTPルーティング、API、ヘルスチェック、静的画面配信
- `src/zarr.ts`: S3列挙、Zarrメタデータ/チャンク読取、デコード、日本域抽出、系列メタデータとPNGキャッシュ
- `src/protocol.ts`: version 1の型、量子化設定、未知のメタデータの拒否
- `src/png.ts`: node:zlibを使った不透明8bitグレースケールPNGエンコーダー
- `web/grid.ts`: カタログ検証、ブラウザ標準APIによるPNGデコード
- `web/app.ts`: Leaflet地図、Canvas気象レイヤー、操作UI
- `web/index.html`, `web/styles.css`: 画面構造とスタイル
- `weather-viewer.yaml`: ConfigMap、Deployment、NodePort Service
- `Dockerfile`: 本番コンテナ
- `.github/workflows/publish-image.yml`: PR のビルド検証と main の GHCR 公開
- `README.md`: 利用者・運用者向け手順

## RustFS のデータ契約

保存先は次の形式です。系列は今後追加される可能性があります。

```text
s3://weather/noaa-gfs/YYYYMMDDHH.zarr/
s3://weather/forecast/YYYYMMDDHH.zarr/
```

例:

```text
noaa-gfs/2026091212.zarr/.zgroup
noaa-gfs/2026091212.zarr/.zmetadata
noaa-gfs/2026091212.zarr/_SUCCESS
```

アプリは `S3_PREFIXES` にカンマ区切りで指定した各系列を列挙し、`.zgroup` と `_SUCCESS` の両方が存在するZarrだけを
カタログへ掲載します。パスの階層数やZarr名そのものには依存しません。

2026-09-13の確認時点では、各サイクルは次の構造でした。

- 予報時刻: 0～24時間、3時間間隔、9ステップ
- 格子: 721×1440の全球0.25°格子
- 気象要素: 地上2m気温、地上2m相対湿度、10m東西風、10m南北風、海面更正気圧、
  総降水量、全雲量
- 気象配列: float32、chunk `(1, 361, 720)`、Blosc + Zstandard
- consolidated metadata: `.zmetadata`

既定設定は `S3_BUCKET=weather`、`S3_PREFIXES=noaa-gfs,forecast` です。旧形式の
`weather/noaa/gfs/...` へ戻さないでください。

## 投影と描画に関する重要事項

GFS は緯度・経度の規則格子で、地理院タイルは Web Mercator です。気象データを
経緯度上の長方形画像として地図へ直接引き伸ばすと、緯度方向に位置ずれが発生します。

`web/app.ts` の `WeatherCanvasLayer` は、各格子セルの緯度・経度境界をLeafletの
`latLngToContainerPoint`で画面座標へ変換してから描画します。この再投影処理を維持してください。

表示範囲は20–50°N、118–155°Eです。間引きは行わず、`noaa-gfs` の0.25°間隔の
121×149点は幅149×高さ121、`forecast` の日本第3次メッシュ3024×2400点は
幅2400×高さ3024のグレースケールPNGで返します。第3次メッシュはセル中心の
緯度1/120°・経度1/80°間隔で、境界は22.4–47.6°N、120–150°Eです。
北→南、西→東の向きと、全セルの投影を維持してください。
PNGをそのまま長方形の画像レイヤーとして地図へ引き伸ばさないでください。
要素や系列の変更では `history.replaceState` を使い、ページを再読み込みしません。

背景地図は以下の標準地図タイルです。

```text
https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png
```

画面表示中は「地理院タイル（国土地理院）」へのリンクを常時表示してください。
ズームレベル5～8の小縮尺地図に必要なGEBCO、海上保安庁、NIMA VMAP0の出典も
フッターから削除しないでください。

## 認証情報と安全性

Secretやアクセスキーをリポジトリへ保存しないでください。Kubernetesでは既存の
`default/rustfs-credentials` Secretから以下を参照します。

- `RUSTFS_ACCESS_KEY` → `AWS_ACCESS_KEY_ID`
- `RUSTFS_SECRET_KEY` → `AWS_SECRET_ACCESS_KEY`

認証情報はサーバー側だけで使用し、カタログAPI、格子API、ログ、ブラウザへ返してはいけません。
調査時もSecretの平文を端末出力へ表示しないでください。

## 開発と検証

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run build
docker build -t weather-zarr-viewer:0.1.4 .
kubectl create --dry-run=client --validate=false -f weather-viewer.yaml -o name
kubectl apply --dry-run=server -f weather-viewer.yaml
```

RustFS実データで検証する場合は、まず一時的にポートフォワードします。

```sh
kubectl port-forward -n default service/rustfs 19000:9000
```

別端末で必要な環境変数を安全に設定し、`S3_ENDPOINT_URL=http://127.0.0.1:19000` として
`bun run dev`を起動してください。既定URLは次の通りです。

```text
http://localhost:3000/weather-viewer
http://localhost:3000/weather-viewer/map
http://localhost:3000/weather-viewer/healthz
http://localhost:3000/weather-viewer/api/catalog
```

最低限、カタログに `noaa-gfs/YYYYMMDDHH.zarr` が現れることと、最新サイクルの
`air_temperature_2m`について、カタログのrevisionを指定した `/api/metadata` が系列の全要素と
`noaa-gfs` は121×149点、`forecast` は3024×2400点の座標を返すこと、`/api/grid.png` が
各系列の座標と一致する幅・高さの8bitグレースケールPNGを返すことを確認してください。
実データの認証・ネットワークが利用できない環境では `bun test` の模擬S3で検証し、実データ未検証をPRへ明記してください。

## ビルドとデプロイ

現在のアプリバージョンは `0.1.4` です。main への push で GitHub Actions が
`ghcr.io/uiui611/weather-viewer:main` と `sha-<40桁のcommit SHA>` を公開します。
PR はビルドのみで公開しません。認証は `GITHUB_TOKEN` の `packages: write` を使用します。
GHCR package は初回公開後に Public に設定してください。手順は README.md にあります。
マニフェストは main タグを Always で取得します。GHCR 公開後に GitHub OIDC 認証付き webhook を一度だけ通知します。
通知に失敗しても警告にとどめ、イメージ公開と Actions は成功扱いにします。HTTP 2xx を受付成功とし、
認証やリクエスト内容は受信側で検証します。Pod の起動完了は待ちません。
受信側の専用認証情報・RBAC と VPS の TLS は初回通知前に準備してください。
再実行は最新 main のものを選び、古いコミットのイメージで main タグを上書きしないようにしてください。

```sh
# main への push 後、GitHub Actions のイメージ公開成功と GHCR package の Public 設定を確認
docker pull ghcr.io/uiui611/weather-viewer:main
kubectl apply -f weather-viewer.yaml
kubectl rollout status deployment/weather-zarr-viewer -n default --timeout=180s
```

現在のKubernetes構成:

- Deployment: `weather-zarr-viewer`
- replicas: 3
- Service: `weather-zarr-viewer`
- NodePort: `30810`
- URL prefix: `/weather-viewer`
- RustFS endpoint: `http://rustfs.default.svc.cluster.local:9000`

2026-09-13に `ubuntu.home.arpa/weather-zarr-viewer:0.1.1` をpushし、digest
`sha256:82574c287a9b88afe375c4ee3cef311a19292def71d3dfd22ac7cc65112c1628` で3 Podの
Ready、再起動0、worker1～3への配置を確認しました。LAN側のubuntuホストから
NodePortの `/weather-viewer/healthz` へ到達できています。

同日に `0.1.2` をpushし、digest
`sha256:015643ad8c0ed09ffef5a24137b0e0780cf2f993c2495a37e1833ee9a70c0b1a` で3 Podの
Ready、再起動0、worker1～3への配置を確認しました。サービス経由のヘルスチェックと、
`forecast` / `noaa-gfs` 両系列および気圧レンジ 990～1020 hPa のカタログ応答も確認済みです。

同日に `0.1.3` をpushし、digest
`sha256:cffad4608dbb40f4da8ab8038d849260f0c006c9cc0a0ad3b3d15c6494f80720` で3 Podの
Ready、再起動0、worker1～3への配置を確認しました。`/weather-view` のインデックス、
`/weather-view/map`、ヘルスチェック、両系列のカタログ応答もサービス経由で確認済みです。

同日にベースパスを修正した `0.1.4` をpushし、digest
`sha256:994fe1d96b3b6db3b53114f8d08f2c27f6af121015a49b27c9057a688e7e4e60` で3 Podの
Ready、再起動0、worker1～3への配置を確認しました。`/weather-viewer` のインデックス、
`/weather-viewer/map`、ヘルスチェック、両系列のカタログ応答もサービス経由で確認済みです。

同じタグを上書きする場合、既存Podは自動で新しい内容を取得しません。
タグ上書き後は `kubectl rollout restart` を行うか、マニフェストのイメージタグを更新してください。
再現性が必要な変更では、GHCR の SHA タグまたはdigest指定を推奨します。
main タグを使う場合、過去の ReplicaSet への rollout undo だけでは以前のイメージに戻りません。

## 外部公開

前段Nginxの `/weather-viewer/` locationは、このリポジトリでは管理していません。
NodePortまでは稼働確認済みですが、Nginx経由の公開URLが必要な場合はubuntuサーバー上の
`/home/mizu/containers` リポジトリを別途変更します。その作業前に同リポジトリの
`AGENTS.md`を最後まで読み、既存変更を保持してください。

Nginxの `proxy_pass` は末尾に `/` を付けず、`/weather-viewer/` prefixをupstreamへ
保持する必要があります。

## 既知の制約

- 対応dtypeは `<f4`、`<f8`、`<i4`、`<i8`です。日本第3次メッシュの座標はfloat64です。
- 圧縮配列はBloscのみ対応します。現在のZstandard/LZ4は読めます。
- `forecast_hour`、`valid_time`、`latitude`、`longitude`は1チャンクである前提です。
- 新サイクルが追加されるカタログは5分キャッシュします。
- メタデータは各系列に1つのJSONで、要素切り替えによる再取得は禁止です。内容のSHA-256 revisionをURLへ指定します。
- PNGとメタデータはHTTPで1年間のprivate immutableキャッシュ、エラーはno-storeです。同一Zarrパスの上書きは想定しません。
- PNGは物理量のMath.floor→クランプ→offset減算で符号化し、255を欠測に予約します。範囲はsrc/protocol.tsとREADME.mdにあります。
- 生成PNGは256件、メタデータ生成結果は64件、ブラウザの復元済み格子は128件まで保持します。時間による失効はありません。
- 圧縮オブジェクトはプロセス内で最大40件キャッシュします。3 replicas間では共有されません。
- PNG生成はプロセスごとに1件ずつ行い、1チャンクを直接8bit画素へ変換します。
  大きな格子の全数値配列の保持や、セルごとのasync処理へ戻さないでください。
  カタログ未取得PodのPNG要求でも全オブジェクトを列挙せず、対象Zarrの完了マーカーとrevisionを検証します。
- ヘルスチェックはプロセス生存確認であり、RustFS疎通までは確認しません。
- 国土地理院タイルは利用者のブラウザから直接取得するため、ブラウザから
  `cyberjapandata.gsi.go.jp:443`へ接続できる必要があります。

データ形式や変数を変更する場合は、RustFS上の実際の `.zmetadata` と `_SUCCESS` を
読み取り専用で確認してから実装・検証してください。
