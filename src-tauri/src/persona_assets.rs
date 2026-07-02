//! 人设语料：编译期嵌入 XOR 密文，运行时解密后由 `/api/assets` 下发给前端。

const ENCRYPTED: &[u8] = include_bytes!("../assets/persona-assets.enc");
const XOR_KEY: &[u8] = b"kxyy-prompt-v1";

fn xor_decrypt(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ XOR_KEY[i % XOR_KEY.len()])
        .collect()
}

/// 解密并返回 JSON 字符串（systemPrompt / fewShot / lore 等）。
pub fn decrypted_json() -> Result<String, String> {
    let plain = xor_decrypt(ENCRYPTED);
    String::from_utf8(plain).map_err(|e| format!("语料解密失败: {e}"))
}
