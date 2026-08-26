# Báo cáo rà soát zalo-tg

Ngày rà soát: 24/06/2026  
Phạm vi: toàn bộ source TypeScript, test hiện có, cấu hình runtime, persistence, Docker/Compose, dependency tree và contract của `zca-js@2.1.2` đã cài trong lockfile.

## Kết luận

Repository **chưa thể được xác nhận “hoàn hảo 100%”**. Sau đợt sửa này, phần logic có thể kiểm tra offline đã ổn định hơn đáng kể, nhưng bridge vẫn phụ thuộc vào một API Zalo không chính thức, payload có thể thay đổi và chưa có test end-to-end với tài khoản Zalo/Telegram thật.

Trạng thái đã xác minh:

| Hạng mục | Kết quả |
|---|---:|
| TypeScript strict build | Pass |
| Test | 70/70 pass |
| File test | 10 |
| Test ban đầu | 7 |
| Audit dependency production | 0 vulnerability |
| Coverage của các module được test nạp vào | 93,50% line / 85,93% branch / 87,67% function |
| Docker image/Compose chạy thật | Chưa xác minh trong môi trường này vì không có Docker daemon |

> Coverage ở trên **không** đại diện cho toàn bộ 9.700+ dòng source. Các handler lớn chưa được import vào coverage report sẽ không xuất hiện thay vì bị tính 0%.

## Contract `zca-js` đã đối chiếu

- Project khóa `zca-js` ở `2.1.2`.
- Listener reaction dùng mục tiêu trong `data.content.rMsg[]`; mỗi phần tử có `gMsgID`, `cMsgID`, `msgType`.
- Trên payload mobile/DM, `gMsgID` có thể bằng `0`; `cMsgID` phải được dùng làm fallback.
- `msgId`/`cliMsgId` ngoài cùng của payload reaction là ID của **event reaction**, không nên ưu tiên làm ID tin nhắn bị reaction khi `rMsg` tồn tại.
- `sendVoice` của 2.1.2 chỉ nhận `voiceUrl` và `ttl`; field `duration` trước đây được truyền vào nhưng bị library bỏ qua.
- API chính đã được đổi từ `any` sang type `API` của `zca-js`; các chỗ không khớp contract đã được sửa hoặc cô lập ở boundary payload động.

## Lỗi đã sửa

### Reaction và mapping

- Xử lý đúng `gMsgID=0` bằng `cMsgID`.
- Thu thập tất cả target trong `rMsg`, lọc `0`/rỗng, khử trùng lặp và chỉ fallback outer IDs cho payload legacy.
- Sửa topic index để quan hệ Telegram topic ↔ Zalo thread luôn one-to-one.
- Sửa ref-count/remap của `msgStore`, tránh quote mồ côi và tránh tăng sai cache khi lưu ID trùng.
- Sửa stale reverse index của sent-message, poll, user name theo nhóm, global name và alias.

### An toàn và phân quyền

- `/login`, `/loginweb`, `/loginapp`, `/autoreply`, `/update`, `/admin`, `/seed` và callback admin/update được kiểm tra quyền operator/admin.
- Callback update kiểm tra đúng target group và escape HTML từ changelog/error.
- Update/restart đi qua graceful shutdown thay vì thoát process trực tiếp từ handler.
- `credentials.json` và `app-session.json` được ghi với mode `0600` trên nền tảng POSIX; file cũ cũng được siết quyền khi ghi lại.
- Validate `TG_GROUP_ID` là số nguyên âm an toàn và validate URL local Bot API khi bật.

### Formatting và media

- Truncate theo grapheme, không cắt đôi surrogate/emoji tổ hợp.
- Escape Telegram HTML và tạo thẻ lồng hợp lệ kể cả khi range style giao nhau.
- Validate mention range, bỏ overlap/out-of-range.
- Sửa nhận diện extension khi URL có query/hash.
- Tạo tên temp duy nhất cho conversion/thumbnail/palette để tránh ghi đè khi chạy đồng thời.
- Validate retry count và giữ file copy thuộc bridge tách khỏi cache của local Bot API.

### Persistence, runtime và deploy

- Tạo thư mục cha trước khi ghi auto-reply/session.
- Cache trạng thái app-session thiếu/hỏng để tránh đọc disk lặp vô hạn.
- Docker Compose dùng DNS service `telegram-bot-api` thay vì `localhost` bên trong container.
- Thêm health dependency giữa hai service.
- Docker production install dùng `npm ci --omit=dev`.
- Vá dependency gián tiếp production lên `form-data@4.0.6` và `ws@8.21.0`.
- Thêm CI Node 20/22, script `check`, coverage và production audit.

## Test mới

Các nhóm test hiện có:

- cấu hình bắt buộc, path, flag và local Bot API;
- Unicode/grapheme, HTML escaping, mention, nested/crossing style;
- reaction mobile `gMsgID=0`, multiple targets, dedupe và fallback legacy;
- topic/message/user/alias/sent-message/reaction/poll stores;
- gzip persistence và malformed persistence;
- filename, media batch, URL extension, file URL copy, temp cleanup;
- album ordering, duplicate URL, delayed Telegram media update và concurrent echo suppression;
- auto-reply persistence, DM-only, cooldown, success/failure cleanup;
- Telegram queue concurrency, non-429 error và retry 429;
- lifecycle shutdown idempotence;
- private file permission.

## Rủi ro và phần còn thiếu

### Ưu tiên cao

1. **Chưa có E2E live.** Cần một môi trường staging với tài khoản Zalo/Telegram riêng để test đăng nhập QR, reconnect, DM/group, media, poll, reaction, undo, typing, seen, friend/group events và rate-limit thật.
2. **API Zalo không chính thức.** Thay đổi phía Zalo có thể làm hỏng login, listener hoặc endpoint mà không có versioning/SLA ổn định.
3. **Các PC App endpoint bị hard-code.** `group-wpa`, `profile-wpa`, `friend-wpa`, `zpw_ver`, user-agent và crypto flow có thể đổi bất kỳ lúc nào.
4. **Coverage handler còn thấp/không đo toàn repo.** `telegram/handler.ts` và phần lớn `zalo/handler.ts` cần được tách thành các hàm thuần/adapters để unit test được payload và API call.

### Ưu tiên trung bình

5. Một số event (`undo`, `reaction`, `group_event`, `friend_event`, `typing`, `seen_messages`) vẫn dùng `any` vì type upstream chưa đủ ổn định. Nên thêm schema runtime (ví dụ Zod/Valibot hoặc type guards tự viết) tại listener boundary.
6. Reaction removal hiện bị bỏ qua khi `rIcon` rỗng; Telegram native reaction/summary có thể còn hiển thị reaction đã gỡ.
7. Mapping Zalo message ID đang dùng key toàn cục. Nếu `cMsgID` không duy nhất giữa các thread, cần đổi key sang `(threadId, messageId)` và migrate persistence.
8. `pollStore` chưa có API delete/TTL/GC rõ ràng; dữ liệu poll có thể tăng theo thời gian.
9. Persistence dùng debounce 1–2 giây; crash/power loss có thể mất mapping vừa phát sinh dù shutdown bình thường đã chờ flush.
10. `/recall` vẫn dành cho mọi thành viên trusted group theo thiết kế hiện tại. Cần quyết định policy: admin-only, chỉ người gửi gốc, hoặc giữ nguyên.

### Ưu tiên thấp / vận hành

11. Full `npm audit` còn một cảnh báo **low** trong dev-only `tsx -> esbuild@0.27.7`, liên quan esbuild development server trên Windows. Project không chạy esbuild dev server và production audit bằng 0; hiện chưa có bản update tương thích tự động từ dependency chain.
12. Chưa có ESLint/formatter gate; các comment eslint hiện không được thực thi bởi CI.
13. Compose dùng image tag `latest` cho Telegram Bot API; nên pin version hoặc digest để deploy tái lập được.
14. Chưa test Docker image/Compose thật trong môi trường rà soát này.
15. Nên bổ sung metrics/health endpoint, structured logging, backup/restore test và runbook rollback update.

## Lệnh xác minh

```bash
npm ci
npm run check
npm run test:coverage
npm run security:audit
```

Kết luận thực tế: bản này phù hợp hơn để test staging và vận hành có giám sát, nhưng chưa đủ bằng chứng để gọi là hoàn thiện 100% hoặc production-safe tuyệt đối.
