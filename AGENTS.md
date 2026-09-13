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
- `src/zarr.ts`: S3列挙、Zarrメタデータ/チャンク読取、デコード、日本域抽出
- `web/app.ts`: Leaflet地図、Canvas気象レイヤー、操作UI
- `web/index.html`, `web/styles.css`: 画面構造とスタイル
- `weather-viewer.yaml`: ConfigMap、Deployment、NodePort Service
- `Dockerfile`: 本番コンテナ
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

表示範囲は20–50°N、118–155°Eです。APIは既定で2格子ごと、すなわち約0.5°間隔に
間引き、61×75点を返します。

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
bun run check
bun run build
docker build -t weather-zarr-viewer:0.1.3 .
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
http://localhost:3000/weather-view
http://localhost:3000/weather-view/map
http://localhost:3000/weather-view/healthz
http://localhost:3000/weather-view/api/catalog
```

最低限、カタログに `noaa-gfs/YYYYMMDDHH.zarr` が現れることと、最新サイクルの
`air_temperature_2m`について `/api/grid` が61×75点を返すことを確認してください。

## ビルドとデプロイ

現在のアプリ/イメージタグは `0.1.3` です。

```sh
docker build -t ubuntu.home.arpa/weather-zarr-viewer:0.1.3 .
docker push ubuntu.home.arpa/weather-zarr-viewer:0.1.3
kubectl apply -f weather-viewer.yaml
kubectl rollout status deployment/weather-zarr-viewer -n default --timeout=180s
```

現在のKubernetes構成:

- Deployment: `weather-zarr-viewer`
- replicas: 3
- Service: `weather-zarr-viewer`
- NodePort: `30810`
- URL prefix: `/weather-view`
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

同じタグを上書きする場合、既存Podは自動で新しい内容を取得しません。
タグ上書き後は `kubectl rollout restart` を行うか、マニフェストのイメージタグを更新してください。
再現性が必要な変更では、新しい固定タグまたはdigest指定を推奨します。

## 外部公開

前段Nginxの `/weather-view/` locationは、このリポジトリでは管理していません。
NodePortまでは稼働確認済みですが、Nginx経由の公開URLが必要な場合はubuntuサーバー上の
`/home/mizu/containers` リポジトリを別途変更します。その作業前に同リポジトリの
`AGENTS.md`を最後まで読み、既存変更を保持してください。

Nginxの `proxy_pass` は末尾に `/` を付けず、`/weather-view/` prefixをupstreamへ
保持する必要があります。

## 既知の制約

- 対応dtypeは `<f4`、`<i4`、`<i8`です。
- 圧縮配列はBloscのみ対応します。現在のZstandard/LZ4は読めます。
- `forecast_hour`、`valid_time`、`latitude`、`longitude`は1チャンクである前提です。
- カタログは60秒キャッシュします。
- 圧縮オブジェクトはプロセス内で最大40件キャッシュします。3 replicas間では共有されません。
- ヘルスチェックはプロセス生存確認であり、RustFS疎通までは確認しません。
- 国土地理院タイルは利用者のブラウザから直接取得するため、ブラウザから
  `cyberjapandata.gsi.go.jp:443`へ接続できる必要があります。

データ形式や変数を変更する場合は、RustFS上の実際の `.zmetadata` と `_SUCCESS` を
読み取り専用で確認してから実装・検証してください。
