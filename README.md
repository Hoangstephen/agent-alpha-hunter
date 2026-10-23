# 🦅 Agent Alpha Hunter (BNB Chain × Binance Agentic Wallet)

by x : [@HoangFUDSCAM](https://x.com/HoangFUDSCAM)

> 👉 **Hướng dẫn sử dụng:** bấm đúp file **HUONG-DAN-SU-DUNG.html** trong thư mục này (mở bằng trình duyệt).
> 👉 **English guide:** open **GUIDE-EN.html** · **中文指南：** 打开 **GUIDE-ZH.html**

Bot tìm NFT "alpha" đang được mint trên BNB Chain, chấm điểm rủi ro, rồi mint qua **Binance Agentic Wallet** (CLI `baw`). Bot **không bao giờ** cần seed phrase hay private key: việc ký do Binance làm, bạn đăng nhập bằng QR trong app.

## Đã kiểm chứng những gì

| Thứ trong hướng dẫn | Kết quả |
|---|---|
| Skill `binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet` | Có thật (repo chính thức của Binance, skill v1.13.0). Skill điều khiển CLI `baw` (npm `@binance/agentic-wallet`, bản 1.11.0). Có lệnh `contract-call preview/execute` để gọi hợp đồng bất kỳ, tức là mint được, với điều kiện **bật Developer Mode**. |
| gang.fun ("Gang 发射台") | Có thật: launchpad bonding-curve trên BSC, **chỉ ví có Agent ID (.ai)** mới tạo/mua/bán được. Nhưng đây là **token**, không phải NFT. Bot chỉ báo token mới, việc mua dùng `gang` CLI chính chủ (github.com/gangfun/gang-launchpad). |
| "Agent ID" | Tên miền `.ai` của SPACE ID, là NFT soulbound trên BSC (registry `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`). Nhiều dự án NFT mới chỉ cho ví có Agent ID mint, nên "alpha" chính là các mint kiểu này. |
| Không dùng được | Grok không cần thiết: bot gọi `baw` trực tiếp. "hark.com/chat" trong ảnh không liên quan tới việc mint. |

## Bot làm gì

1. **Quét mint on-chain**: đọc log `Transfer` từ `address(0)` (ERC-721) và `TransferSingle` (ERC-1155) trên các block gần nhất, gom theo hợp đồng, đếm số ví mint khác nhau, rồi kiểm tra **bao nhiêu % người mint có Agent ID**. Tỉ lệ cao = mint chỉ dành cho agent = tín hiệu alpha.
2. **gang.fun**: đọc event `Created` của LaunchpadV2 (`0x1B8F…966E`) để liệt kê token mới.
3. **X**: tìm từ khoá `Agent ID mint` / `Agentic Wallet 打` / `Agentic 内盘` (cần `X_BEARER_TOKEN`, X API trả phí). Không có token thì dán tweet vào `data/x-manual.txt`. Bot chỉ trích địa chỉ `0x…` và link.
4. **Chấm rủi ro** (0–100): verify mã nguồn trên BscScan, proxy nâng cấp được, SELFDESTRUCT/DELEGATECALL, có phải ERC-721/1155 thật, có hàm mint công khai không, owner là ai.
5. **Luật dự án bằng tiếng Việt** (mục 📜 trên mỗi thẻ NFT), cho mọi NFT:
   - số liệu đọc từ hợp đồng: tổng cung, đã mint, giới hạn ví/giao dịch, giá, giờ mở mint;
   - điều kiện hợp đồng **thực sự kiểm tra**, lấy từ thông báo lỗi trong bytecode (vd. cần Agent ID, giới hạn ví, whitelist, cần chữ ký server, cấm bot);
   - mục Rules / How to mint trên trang web dự án (lấy từ metadata NFT), dịch máy sang tiếng Việt khi bạn mở mục này. Trang dự án tự viết, nên tin số liệu hợp đồng hơn.
   - Thêm luật viết tay cho dự án quen trong `src/projects.js` (đã có Xuanwu Sigil).
6. **NFT trong ví**: bot quét log NFT gửi tới ví, nhớ kết quả ở `data/wallet-nfts.json`. Lần đầu quét tối đa 45 giây; nếu báo "chưa hết" thì bấm lại để quét tiếp về quá khứ.
7. **Mint** theo 3 mức:
   - mặc định **dry-run**: chỉ mô phỏng, in lệnh `baw` sẽ chạy, không gửi gì;
   - `--preview`: Binance mô phỏng + quét rủi ro, vẫn chưa ký;
   - `--live`: sau preview, bạn phải **gõ đúng** `MINT xxxx` (4 ký tự cuối địa chỉ hợp đồng) thì mới execute.

### Hàng rào an toàn (không tắt được bằng cờ)

- Chặn cứng calldata `approve` (trừ approve stablecoin đúng giá cho đúng hợp đồng NFT), `setApprovalForAll`, `transfer(From)`, `safeTransferFrom`, `permit`, `increaseAllowance`, `withdraw`: mint thật không bao giờ cần những lệnh này, drainer thì cần.
- Chặn nếu preview của Binance cho thấy giao dịch **cấp allowance/authority** cho bên khác.
- Trần chi tiêu mỗi lần mint (`maxPerMintBNB`, mặc định 0.05) và mỗi ngày (`maxDailyBNB`, mặc định 0.2), tính cả mint trả bằng USDT, ghi sổ ở `data/spend.json`.
- Từ chối nếu điểm an toàn < `minRiskScore` (mặc định 60) hoặc mô phỏng bị revert.
- Bot **không tự mint** khi quét: chỉ mint khi bạn bấm nút rồi bấm Xác nhận.
- Giao diện chỉ chạy trên máy bạn (127.0.0.1) và chặn request từ trang web khác.
- Nên đặt thêm **Daily Limit** thấp trong app Binance cho Agentic Wallet. Đó là lớp chặn phía Binance, không phụ thuộc vào bot.

## Cách chạy (3 bước)

1. Cài **Node.js 22 LTS** (nodejs.org; bản 20.19+ cũng được). Trong app Binance: Agentic Wallet → bật **Developer Mode**, nạp chút BNB, đặt Daily Limit thấp.
2. Giải nén, **bấm đúp** `start.bat` (Windows) hoặc `start.command` (Mac). Lần đầu nó tự cài mọi thứ.
   Hoặc mở Terminal trong thư mục: `npm install` rồi `npm start`.
3. Trên giao diện: nếu chưa có CLI ví thì bấm **Cài baw**, sau đó bấm **Đăng nhập ví**. Trang QR tự mở, bạn quét bằng app Binance → Agentic Wallet và kiểm tra mã ghép đôi trùng với mã trên giao diện.

Trình duyệt tự mở `http://127.0.0.1:3777`. Ở đó bạn có:
- **NFT đang hot**: tự quét mỗi 5 phút. Mỗi thẻ có giá, tối đa/ví, đã mint/tổng cung, % ví Agent ID, điểm an toàn.
- **Chọn số lượng tuỳ dự án**: ô số lượng + nút nhanh 1 / 5 / 10 / Max. Max = nhỏ nhất của: giới hạn mỗi ví (trừ số bạn đã mint), giới hạn mỗi giao dịch, số còn lại, trần chi tiêu. Dự án không công bố giới hạn thì mặc định tối đa 20 (`defaultMaxQty`).
- **Giá**: giá đọc từ hợp đồng (BNB hoặc USDT/USDC, free mint hiện "Miễn phí"), **giá người khác đang thật sự trả** (đọc từ 10 giao dịch mint gần nhất, kèm phí gas), **giá đang bán được** (trung vị/cao nhất gần đây) và **lãi ước tính mỗi NFT**.
- **Mint**: bấm → Binance mô phỏng → hiện tổng tiền + cảnh báo → bấm **Xác nhận mint** mới gửi. Mint trả bằng USDT có thêm bước 1 là approve **đúng số tiền** cho **đúng hợp đồng NFT** (không approve vô hạn).
- **Ô dán địa chỉ**: thấy NFT nào trên X thì dán địa chỉ 0x vào để kiểm tra và mint.
- **Bán NFT đang giữ**: bấm "Tìm giá bán cao nhất". Bot tìm NFT trong ví (NFT đã mint qua bot, NFT đang hot, hoặc địa chỉ bạn thêm) rồi so giá:
  - lệnh mua đang chờ trên **Element** (bán ngay được, cần `ELEMENT_API_KEY`);
  - **giá bán gần đây trên chain** (cao nhất và trung vị, đọc từ giao dịch trả BNB/WBNB/USDT cho người bán).
  Bot **không tự đăng bán**: đăng bán cần cấp `setApprovalForAll` cho sàn, đúng kiểu drainer hay lừa. Bấm link "Bán trên Element" và làm trên trang chính thức.
- **Quyền token đã cấp**: bấm "Xem quyền đã cấp" để thấy mọi hợp đồng đang được phép tiêu token của ví (lấy từ `baw approvals list`), kèm hạn mức (vô hạn hay không) và mức rủi ro Binance đánh giá. Bấm **Revoke** để thu hồi (tốn ít gas, quyền hết hẳn khi giao dịch được xác nhận).
- **Số dư ví**: tổng ≈ USDT và từng token (từ `baw wallet balance`), tự làm mới mỗi phút.
- **Dự án kiểu "mint đầu free, sau trả phí"** (ví dụ Xuanwu Sigil): bot dò giá thật cho ví bạn bằng cách gọi thử hợp đồng (eth_call, không gửi gì), nên lần 1 gửi 0, lần 2-3 gửi đúng phí. Hàm `mint()` không có tham số số lượng thì chọn N sẽ gửi N giao dịch, mỗi cái xác nhận riêng.
- **⏰ Chờ mở mint**: bot gọi thử mỗi 2 giây; mint vừa mở là kêu bíp và hiện hộp xác nhận, bạn chỉ cần bấm.
- **Điểm an toàn 40-59**: có ô "Tôi đã tự kiểm tra hợp đồng" để vẫn mint được. Dưới 40 luôn chặn.
- **Quy đổi USDT**: mọi giá BNB đều kèm ≈ USDT. Giá lấy từ Binance API, nếu lỗi thì đọc pool WBNB/USDT trên PancakeSwap.

Không cần cấu hình RPC: bot tự thử danh sách RPC BSC công khai và tự đổi khi một cái lỗi. Muốn dùng RPC riêng thì đặt `BSC_RPC_URL`.

Tuỳ chọn (biến môi trường, không ghi vào file):

```bash
export ETHERSCAN_API_KEY="…"   # kiểm tra mã nguồn đã verify chưa (miễn phí ở etherscan.io)
export X_BEARER_TOKEN="…"      # tự tìm từ khoá trên X (X API trả phí)
export ELEMENT_API_KEY="…"     # đọc lệnh mua NFT trên sàn Element (đăng ký key ở element.market)
```

Trần chi tiêu nằm trong `config.json` (chép từ `config.example.json` nếu muốn đổi).

### Dòng lệnh (nếu thích)

```bash
node src/index.js scan
node src/index.js inspect 0xHopDong
node src/index.js mint 0xHopDong --qty 2            # dry-run
node src/index.js mint 0xHopDong --qty 2 --live     # mint thật, gõ xác nhận
```

## Test

```bash
npm test   # 21 test offline (đã thêm ca giống Xuanwu Sigil): node BSC giả + baw giả, có test end-to-end giao diện web (quét, mint nhiều cái, mint trả USDT, bán, giá USDT, đăng nhập, revoke)
```

## Giới hạn cần biết

- Điểm rủi ro là bộ lọc thô, **không** chứng nhận hợp đồng an toàn. Luôn tự xem hợp đồng trên BscScan. Đây không phải lời khuyên đầu tư; NFT/token mới có thể mất trắng.
- RPC công khai: bot thử tất cả cùng lúc khi khởi động, chọn RPC nhanh nhất để đọc hợp đồng và **riêng** một RPC lấy được log (bsc-dataseed của BNB Chain không lấy log được). Nếu log vẫn hay lỗi, đặt `BSC_RPC_URL` là RPC riêng miễn phí ([NodeReal](https://nodereal.io/invite/8404ae7b-f5ed-4d38-acf7-1e03e9711676), Ankr, QuickNode…).
- Bot chưa chạy thật trên mainnet trong lúc viết (môi trường build không truy cập được RPC BSC). Hãy chạy `scan` và `mint … --preview` trước khi dùng `--live`.
- Nội dung tweet, tên token, tên NFT đều là dữ liệu không tin cậy (có thể chứa lừa đảo / prompt injection). Không bao giờ dán seed phrase vào bất kỳ đâu, kể cả "AI hỗ trợ".

---

## ☕ Ủng hộ tác giả

**Nếu các bạn thấy BOT hay, hãy donate cho mình vài cốc trà đá để mình có thêm động lực làm thêm các bot!**

- BNB (BSC): `0xe85613938f85e8d791b8427a6b57d8fa864f1e97`
- ETH: `0xe85613938f85e8d791b8427a6b57d8fa864f1e97`

**NFA · DYOR**: không phải lời khuyên tài chính, hãy tự tìm hiểu trước khi mint.

x : [@HoangFUDSCAM](https://x.com/HoangFUDSCAM)
