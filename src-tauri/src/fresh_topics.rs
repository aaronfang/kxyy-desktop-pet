use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const CACHE_SCHEMA_VERSION: u32 = 9;
const CACHE_MAX_ITEMS: usize = 200;
const PROVIDER_POOL_MAX_ITEMS: usize = 360;
const QUERY_MAX_ITEMS: usize = 3;
const TOPIC_MAX_AGE_DAYS: i64 = 7;
const PROVIDER_REFRESH_HOURS: i64 = 6;
const MANUAL_REFRESH_COOLDOWN_SECONDS: i64 = 30;
#[allow(dead_code)]
const GDELT_MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(5);
const VALID_CATEGORIES: &[&str] = &[
    "general",
    "film-tv",
    "games",
    "technology",
    "music",
    "food",
    "travel",
    "books",
    "sports",
    "work-growth",
    "daily-life",
    "science",
];

const DEFAULT_TOPIC_PREFERENCES: &[(&str, &str)] = &[
    ("电影影视", "film-tv"),
    ("游戏", "games"),
    ("科技数码", "technology"),
    ("音乐", "music"),
    ("美食", "food"),
    ("旅行", "travel"),
    ("读书", "books"),
    ("运动", "sports"),
    ("工作成长", "work-growth"),
    ("日常生活", "daily-life"),
];

const LOCATION_HINT_MAX_ITEMS: usize = 3;
static LOCATION_HINTS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static WORK_ROLE_HINTS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn normalized_city(value: &str) -> Option<String> {
    let city: String = value
        .trim()
        .trim_end_matches(['市', '区', '县'])
        .chars()
        .filter(|character| {
            character.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(character)
        })
        .take(12)
        .collect();
    (city.chars().count() >= 2).then_some(city)
}

pub fn set_location_hints(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let Some(city) = normalized_city(&value) else {
            continue;
        };
        if !normalized.contains(&city) {
            normalized.push(city);
        }
        if normalized.len() >= LOCATION_HINT_MAX_ITEMS {
            break;
        }
    }
    *LOCATION_HINTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap() = normalized.clone();
    normalized
}

fn location_hints() -> Vec<String> {
    LOCATION_HINTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .clone()
}

pub fn set_work_role_hints(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let role: String = value
            .trim()
            .chars()
            .filter(|character| {
                character.is_alphanumeric() || matches!(character, '+' | '#' | '.' | '-')
            })
            .take(20)
            .collect();
        if role.chars().count() >= 2 && !normalized.contains(&role) {
            normalized.push(role);
        }
        if normalized.len() >= 2 {
            break;
        }
    }
    *WORK_ROLE_HINTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap() = normalized.clone();
    normalized
}

fn work_role_hints() -> Vec<String> {
    WORK_ROLE_HINTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .clone()
}

fn compact_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn canonicalize_url(value: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !key.starts_with("utm_")
                && !matches!(key.as_str(), "fbclid" | "gclid" | "mc_cid" | "mc_eid")
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();

    // Migrate links written by older builds to 汽水音乐's current share route.
    let mut legacy_soda_track_id = None;
    if url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("music.douyin.com"))
        && url
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .as_deref()
            .is_some_and(|segments| segments.len() == 2 && segments[0] == "song")
    {
        let segments = url
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())?;
        let track_id = segments[1].to_string();
        if !track_id.is_empty() && track_id.chars().all(|character| character.is_ascii_digit()) {
            url.set_path("/qishui/share/track");
            legacy_soda_track_id = Some(track_id);
        }
    }
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    if let Some(track_id) = legacy_soda_track_id {
        url.query_pairs_mut().append_pair("track_id", &track_id);
    }
    let result = url.to_string();
    (result.chars().count() <= 512).then_some(result)
}

fn normalized_title_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .take(120)
        .collect()
}

fn quoted_title_subject(value: &str) -> Option<String> {
    let start = value.find('《')? + '《'.len_utf8();
    let tail = &value[start..];
    let end = tail.find('》')?;
    let subject = normalized_title_key(&tail[..end]);
    (subject.chars().count() >= 2).then_some(subject)
}

fn event_action(value: &str) -> Option<&'static str> {
    let compact = normalized_title_key(value);
    [
        ("免费领取", "free"),
        ("免费领", "free"),
        ("上线", "launch"),
        ("发布", "release"),
        ("发售", "release"),
        ("上映", "premiere"),
        ("开播", "premiere"),
        ("获奖", "award"),
        ("夺冠", "award"),
        ("召回", "recall"),
    ]
    .into_iter()
    .find_map(|(needle, action)| compact.contains(needle).then_some(action))
}

fn same_topic_event(left: &FreshTopic, right: &FreshTopic) -> bool {
    if left.category != right.category {
        return false;
    }
    match (
        quoted_title_subject(&left.title),
        quoted_title_subject(&right.title),
        event_action(&left.title),
        event_action(&right.title),
    ) {
        (Some(left_subject), Some(right_subject), Some(left_action), Some(right_action)) => {
            left_subject == right_subject && left_action == right_action
        }
        _ => false,
    }
}

fn normalized_topic(mut item: FreshTopic) -> Option<FreshTopic> {
    item.source_id = compact_text(&item.source_id, 96);
    item.source_name = compact_text(&item.source_name, 64);
    item.canonical_url = canonicalize_url(&item.canonical_url)?;
    item.title = compact_text(&item.title, 120);
    item.short_text = compact_text(&item.short_text, 240);
    item.category = item.category.trim().to_ascii_lowercase();
    item.locale = compact_text(&item.locale, 16);
    item.fetched_at = chrono::DateTime::parse_from_rfc3339(&item.fetched_at)
        .ok()?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    item.published_at = item
        .published_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    if item.source_id.is_empty()
        || item.source_name.is_empty()
        || item.title.is_empty()
        || item.short_text.is_empty()
        || item.locale.is_empty()
        || !VALID_CATEGORIES.contains(&item.category.as_str())
    {
        return None;
    }
    Some(item)
}

fn topic_time(item: &FreshTopic) -> &str {
    item.published_at.as_deref().unwrap_or(&item.fetched_at)
}

fn normalize_topics_unbounded(items: Vec<FreshTopic>) -> Vec<FreshTopic> {
    let mut result: Vec<FreshTopic> = Vec::new();
    for item in items.into_iter().filter_map(normalized_topic) {
        let title_key = normalized_title_key(&item.title);
        if let Some(index) = result.iter().position(|existing| {
            existing.canonical_url == item.canonical_url
                || normalized_title_key(&existing.title) == title_key
                || same_topic_event(existing, &item)
        }) {
            if topic_time(&item) > topic_time(&result[index]) {
                result[index] = item;
            }
            continue;
        }
        result.push(item);
    }
    result.sort_by(|left, right| topic_time(right).cmp(topic_time(left)));
    result
}

fn normalize_topics(items: Vec<FreshTopic>) -> Vec<FreshTopic> {
    let mut result = normalize_topics_unbounded(items);
    result.truncate(CACHE_MAX_ITEMS);
    result
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn daily_event_family(item: &FreshTopic) -> Option<String> {
    if item.category != "daily-life" {
        return None;
    }
    let text = format!("{} {}", item.title, item.short_text);
    for keyword in ["台风", "暴雨", "高温", "洪水", "地震", "寒潮", "沙尘"] {
        if !text.contains(keyword) {
            continue;
        }
        if keyword != "台风" {
            return Some(format!("weather:{keyword}"));
        }
        if text.contains("白海豚") {
            return Some("weather:台风:白海豚".into());
        }
        let suffix = text
            .split_once(keyword)
            .map(|(_, suffix)| suffix)
            .unwrap_or("");
        let suffix = suffix.trim_start_matches(['：', ':', '“', '"', '《', ' ']);
        let name: String = suffix
            .chars()
            .take_while(|character| {
                character.is_alphanumeric()
                    && !matches!(character, '第' | '将' | '已' | '在' | '于' | '的')
            })
            .take(4)
            .collect();
        let name = name.trim_end_matches(['”', '"', '》']).to_string();
        return Some(if name.chars().count() >= 2 {
            format!("weather:台风:{name}")
        } else {
            "weather:台风".into()
        });
    }
    None
}

/// Keep the proactive cache focused on conversational subjects rather than
/// category-adjacent news events. This is deliberately conservative: a quota
/// shortfall is preferable to filling a category with irrelevant headlines.
fn is_category_object_candidate(item: &FreshTopic) -> bool {
    let text = format!("{} {}", item.title, item.short_text).to_lowercase();
    let has_real_summary =
        normalized_title_key(&item.title) != normalized_title_key(&item.short_text);
    match item.category.as_str() {
        "books" => {
            item.source_name == "百度热榜"
                || (item.title.contains('《')
                    && contains_any(&text, &["简介", "书评", "推荐", "新书", "小说"]))
        }
        "film-tv" => {
            !contains_any(&text, &["总票房", "票房突破", "票房市场", "电影市场"])
                && (matches!(item.source_name.as_str(), "百度热榜" | "豆瓣电影")
                    || (item.title.contains('《')
                        && has_real_summary
                        && contains_any(&text, &["电影", "影片", "剧集", "影评", "推荐", "上映"])))
        }
        "music" => {
            !contains_any(&text, &["演唱会", "音乐节", "生日快乐", "音乐盛宴"])
                && has_real_summary
                && (item.source_name == "汽水音乐"
                    || contains_any(
                        &text,
                        &["新歌", "单曲", "专辑", "歌曲", "mv", "乐评", "音乐作品"],
                    ))
        }
        "travel" => {
            !contains_any(&text, &["失踪", "遇难", "事故", "待遇", "演员", "案件"])
                && (matches!(item.source_name.as_str(), "必应分类搜索" | "携程景点榜")
                    || contains_any(
                        &text,
                        &[
                            "景点",
                            "景区",
                            "目的地",
                            "旅行攻略",
                            "旅游攻略",
                            "必去",
                            "打卡",
                            "好玩",
                            "游玩路线",
                            "citywalk",
                        ],
                    ))
                && (has_real_summary
                    || contains_any(
                        &item.title,
                        &["景点", "景区", "目的地", "打卡", "好玩", "游玩"],
                    ))
        }
        "food" => {
            (matches!(
                item.source_name.as_str(),
                "必应分类搜索" | "城市餐饮搜索" | "携程餐厅榜"
            ) || contains_any(
                &text,
                &[
                    "美食",
                    "餐厅",
                    "餐馆",
                    "饭店",
                    "小吃",
                    "探店",
                    "必吃",
                    "美食街",
                    "招牌菜",
                    "人均",
                    "评分",
                ],
            )) && contains_any(
                &text,
                &[
                    "餐厅",
                    "餐馆",
                    "饭店",
                    "小吃",
                    "探店",
                    "必吃",
                    "美食街",
                    "招牌菜",
                    "人均",
                    "评分",
                ],
            ) && !contains_any(
                &text,
                &[
                    "食品安全事件",
                    "中毒事件",
                    "菜谱",
                    "做法",
                    "步骤",
                    "烹饪",
                    "配料",
                    "调料",
                    "旅游攻略",
                    "旅行攻略",
                    "景点",
                    "景区",
                    "城市简介",
                    "城市介绍",
                    "旅游",
                    "游记",
                    "目的地",
                ],
            )
        }
        "games" => {
            !contains_any(
                &text,
                &["客户端更新", "修复异常", "战队", "冠军", "电竞世俱杯"],
            ) && ((matches!(
                item.source_name.as_str(),
                "Steam 热门榜" | "Steam 限时免费" | "App Store 新游" | "Steam 新游" | "Epic 限免"
            ) && has_real_summary)
                || item.title.contains('《')
                || contains_any(
                    &text,
                    &["新游戏", "游戏推荐", "新作", "试玩", "玩法", "游戏介绍"],
                ))
        }
        "technology" => {
            !contains_any(&text, &["医疗垃圾", "会议软件停用"])
                && (has_real_summary
                    || contains_any(&text, &["新品", "新机", "发布", "评测", "体验", "功能介绍"]))
        }
        "work-growth" => {
            contains_any(
                &text,
                &[
                    "招聘", "职位", "岗位", "招募", "社招", "校招", "薪资", "月薪", "福利", "面试",
                ],
            ) && has_real_summary
                && !contains_any(
                    &text,
                    &[
                        "招聘平台",
                        "招聘网站",
                        "平台介绍",
                        "官网",
                        "app",
                        "是什么意思",
                        "百科",
                        "定义",
                        "失踪",
                        "精神病",
                        "旅游胜地",
                    ],
                )
        }
        "daily-life" => !contains_any(&text, &["军事行动", "以军", "枪口", "战争", "袭击", "伤亡"]),
        "sports" | "science" => true,
        _ => false,
    }
}

#[allow(dead_code)]
fn parse_hacker_news_story(payload: &serde_json::Value, fetched_at: &str) -> Option<FreshTopic> {
    if payload.get("type").and_then(|value| value.as_str()) != Some("story")
        || payload.get("deleted").and_then(|value| value.as_bool()) == Some(true)
        || payload.get("dead").and_then(|value| value.as_bool()) == Some(true)
    {
        return None;
    }
    let id = payload.get("id").and_then(|value| value.as_u64())?;
    let timestamp = payload.get("time").and_then(|value| value.as_i64())?;
    let published_at = chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    normalized_topic(FreshTopic {
        source_id: format!("hacker-news:{id}"),
        source_name: "Hacker News".into(),
        canonical_url: payload.get("url").and_then(|value| value.as_str())?.into(),
        title: payload
            .get("title")
            .and_then(|value| value.as_str())?
            .into(),
        published_at: Some(published_at),
        fetched_at: fetched_at.into(),
        short_text: payload
            .get("title")
            .and_then(|value| value.as_str())?
            .into(),
        category: "technology".into(),
        locale: "en-US".into(),
    })
}

#[allow(dead_code)]
fn parse_gdelt_articles(payload: &serde_json::Value, fetched_at: &str) -> Vec<FreshTopic> {
    payload
        .get("articles")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take(30)
        .filter_map(|article| {
            if article
                .get("sourcecountry")
                .and_then(|value| value.as_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("china"))
            {
                return None;
            }
            let raw_url = article.get("url").and_then(|value| value.as_str())?;
            let url = canonicalize_url(raw_url)?;
            let title = article.get("title").and_then(|value| value.as_str())?;
            let domain = article
                .get("domain")
                .and_then(|value| value.as_str())
                .map(|value| compact_text(value, 64))
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    reqwest::Url::parse(&url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_string))
                })?;
            let published_at = article
                .get("seendate")
                .and_then(|value| value.as_str())
                .and_then(|value| {
                    chrono::NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ").ok()
                })
                .map(|value| {
                    value
                        .and_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                });
            let locale = match article
                .get("language")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "chinese" | "mandarin" => "zh-CN",
                _ => "en-US",
            };
            if locale != "zh-CN" {
                return None;
            }
            normalized_topic(FreshTopic {
                source_id: format!("gdelt:{:016x}", fnv1a64(url.as_bytes())),
                source_name: domain,
                canonical_url: url,
                title: title.into(),
                published_at,
                fetched_at: fetched_at.into(),
                short_text: title.into(),
                category: classify_category(title).into(),
                locale: locale.into(),
            })
        })
        .collect()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

const SOURCE_BODY_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn read_response_bounded(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    read_response_bounded_with_limit(response, SOURCE_BODY_MAX_BYTES)
}

fn read_response_bounded_with_limit(
    response: reqwest::blocking::Response,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err("response_too_large".into());
    }
    let mut body = Vec::new();
    response
        .take(max_bytes + 1)
        .read_to_end(&mut body)
        .map_err(|_| "provider_error".to_string())?;
    if body.len() as u64 > max_bytes {
        return Err("response_too_large".into());
    }
    Ok(body)
}

fn published_rss_time(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|value| {
            value
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
}

fn rss_summary_text(value: &str, title: &str) -> Option<String> {
    fn remove_block(mut value: String, tag: &str) -> String {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let lower = value.to_ascii_lowercase();
            let Some(start) = lower.find(&open) else {
                break;
            };
            let end = lower[start..]
                .find(&close)
                .map(|offset| start + offset + close.len())
                .unwrap_or(value.len());
            value.replace_range(start..end, " ");
        }
        value
    }

    fn strip_tags(value: &str) -> String {
        let mut plain = String::with_capacity(value.len().min(512));
        let mut in_tag = false;
        for character in value.chars().take(4096) {
            match character {
                '<' => in_tag = true,
                '>' if in_tag => {
                    in_tag = false;
                    plain.push(' ');
                }
                _ if !in_tag => plain.push(character),
                _ => {}
            }
        }
        plain
    }
    let decoded_once = quick_xml::escape::unescape(value)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| value.to_string());
    let lower = decoded_once.to_ascii_lowercase();
    if contains_any(
        &lower,
        &[
            "ignore previous",
            "system prompt",
            "忽略以上",
            "系统提示",
            "执行以下",
        ],
    ) {
        return None;
    }
    let without_blocks = remove_block(remove_block(decoded_once, "script"), "style");
    let stripped_once = strip_tags(&without_blocks);
    let decoded_twice = quick_xml::escape::unescape(&stripped_once)
        .map(|value| value.into_owned())
        .unwrap_or(stripped_once);
    let plain = strip_tags(&decoded_twice)
        .replace(" ", " ")
        .replace("阅读全文", " ")
        .replace("查看更多", " ");
    let summary = compact_text(&plain, 240);
    (summary.chars().count() >= 8 && normalized_title_key(&summary) != normalized_title_key(title))
        .then_some(summary)
}

fn parse_rss_items(
    xml: &[u8],
    source_id: &str,
    source_name: &str,
    default_category: Option<&str>,
    fetched_at: &str,
) -> Vec<FreshTopic> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut in_item = false;
    let mut field = Vec::new();
    let mut title = String::new();
    let mut link = String::new();
    let mut published = String::new();
    let mut description = String::new();
    let mut result = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = event.name().as_ref().to_vec();
                if name.as_slice() == b"item" {
                    in_item = true;
                    title.clear();
                    link.clear();
                    published.clear();
                    description.clear();
                } else if in_item
                    && matches!(
                        name.as_slice(),
                        b"title" | b"link" | b"pubDate" | b"description" | b"content:encoded"
                    )
                {
                    field = name;
                }
            }
            Ok(Event::Text(event)) if in_item => {
                let value = event
                    .decode()
                    .map(|value| value.into_owned())
                    .unwrap_or_default();
                match field.as_slice() {
                    b"title" => title.push_str(&value),
                    b"link" => link.push_str(&value),
                    b"pubDate" => published.push_str(&value),
                    b"description" | b"content:encoded" => description.push_str(&value),
                    _ => {}
                }
            }
            Ok(Event::CData(event)) if in_item => {
                let value = event
                    .decode()
                    .map(|value| value.into_owned())
                    .unwrap_or_default();
                match field.as_slice() {
                    b"title" => title.push_str(&value),
                    b"link" => link.push_str(&value),
                    b"pubDate" => published.push_str(&value),
                    b"description" | b"content:encoded" => description.push_str(&value),
                    _ => {}
                }
            }
            Ok(Event::GeneralRef(event)) if in_item => {
                let reference: &[u8] = event.as_ref();
                let decoded = match reference {
                    b"lt" => Some('<'),
                    b"gt" => Some('>'),
                    b"quot" => Some('"'),
                    b"apos" => Some('\''),
                    b"amp" => Some('&'),
                    b"nbsp" => Some(' '),
                    _ => None,
                };
                if let Some(decoded) = decoded {
                    match field.as_slice() {
                        b"title" => title.push(decoded),
                        b"link" => link.push(decoded),
                        b"pubDate" => published.push(decoded),
                        b"description" | b"content:encoded" => description.push(decoded),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name().as_ref().to_vec();
                if name.as_slice() == b"item" {
                    let classified = classify_category(&title);
                    let category = if classified == "general" {
                        default_category.unwrap_or("general")
                    } else {
                        classified
                    };
                    if category != "general" {
                        let url = canonicalize_url(&link);
                        let summary = rss_summary_text(&description, &title);
                        if let (Some(canonical_url), Some(short_text)) = (url, summary) {
                            if let Some(topic) = normalized_topic(FreshTopic {
                                source_id: format!(
                                    "{source_id}:{:016x}",
                                    fnv1a64(canonical_url.as_bytes())
                                ),
                                source_name: source_name.into(),
                                canonical_url,
                                title: title.clone(),
                                published_at: published_rss_time(&published),
                                fetched_at: fetched_at.into(),
                                short_text,
                                category: category.into(),
                                locale: "zh-CN".into(),
                            }) {
                                result.push(topic);
                            }
                        }
                    }
                    in_item = false;
                    field.clear();
                    if result.len() >= 80 {
                        break;
                    }
                } else if in_item && name.as_slice() == field.as_slice() {
                    field.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return Vec::new(),
            _ => {}
        }
    }
    result
}

fn source_http_result(
    response: Result<reqwest::blocking::Response, reqwest::Error>,
) -> Result<Vec<u8>, String> {
    match response {
        Ok(response) if response.status().is_success() => read_response_bounded(response),
        Ok(response) => Err(classify_http_status(response.status()).into()),
        Err(error) => Err(classify_request_error(&error).into()),
    }
}

fn classify_category(value: &str) -> &'static str {
    let value = value.to_lowercase();
    if [
        "电影",
        "影视",
        "院线",
        "票房",
        "电视剧",
        "综艺",
        "影片",
        "片子",
        "剧集",
        "新片",
        "追剧",
        "movie",
        "film",
        "cinema",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        "film-tv"
    } else if [
        "游戏",
        "电竞",
        "game",
        "gaming",
        "xbox",
        "playstation",
        "steam",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        "games"
    } else if [
        "科技",
        "人工智能",
        "机器人",
        "脑机接口",
        "芯片",
        "手机",
        "数码",
        "软件",
        "technology",
        " ai ",
        "software",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        "technology"
    } else if [
        "音乐",
        "歌曲",
        "歌单",
        "新歌",
        "歌手",
        "专辑",
        "单曲",
        "乐队",
        "演唱会",
        "听歌",
        "music",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        "music"
    } else if ["美食", "餐厅", "烹饪", "料理", "food"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "food"
    } else if ["旅行", "旅游", "文旅", "景区", "travel"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "travel"
    } else if ["读书", "阅读", "小说", "书籍", "图书", "book"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "books"
    } else if ["运动", "健身", "跑步", "球赛", "体育", "sports"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "sports"
    } else if ["工作", "职场", "学习", "成长", "职业", "效率", "招聘"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "work-growth"
    } else if ["科学", "太空", "航天", "科普", "science", "space"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        "science"
    } else if [
        "日常",
        "生活",
        "家务",
        "天气",
        "健康",
        "作息",
        "睡眠",
        "宠物",
        "消费",
        "lifestyle",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        "daily-life"
    } else {
        "general"
    }
}

fn query_categories(query: &str) -> Vec<&'static str> {
    let value = query.to_ascii_lowercase();
    let mut categories = Vec::new();
    let add = |categories: &mut Vec<&'static str>, category| {
        if !categories.contains(&category) {
            categories.push(category);
        }
    };
    if [
        "电影",
        "影视",
        "院线",
        "票房",
        "电视剧",
        "综艺",
        "影片",
        "片子",
        "剧集",
        "新片",
        "追剧",
        "movie",
        "film",
        "cinema",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        add(&mut categories, "film-tv");
    }
    if [
        "游戏",
        "电竞",
        "手游",
        "端游",
        "主机游戏",
        "新游",
        "限免",
        "steam",
        "xbox",
        "playstation",
        "gaming",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        add(&mut categories, "games");
    }
    if [
        "科技",
        "人工智能",
        "芯片",
        "手机",
        "数码",
        "technology",
        "software",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        add(&mut categories, "technology");
    }
    if [
        "音乐",
        "歌曲",
        "歌单",
        "新歌",
        "歌手",
        "专辑",
        "单曲",
        "乐队",
        "演唱会",
        "听歌",
        "music",
    ]
    .iter()
    .any(|needle| value.contains(needle))
    {
        add(&mut categories, "music");
    }
    for (category, needles) in [
        (
            "food",
            &[
                "美食",
                "餐厅",
                "餐馆",
                "饭店",
                "好吃的",
                "吃什么",
                "探店",
                "小吃",
                "烹饪",
                "料理",
                "food",
            ][..],
        ),
        (
            "travel",
            &[
                "旅行",
                "旅游",
                "景点",
                "出游",
                "去哪玩",
                "去哪儿玩",
                "周边游",
                "度假",
                "travel",
            ][..],
        ),
        (
            "books",
            &[
                "读书", "阅读", "小说", "书籍", "图书", "书单", "新书", "好书", "网文", "book",
            ][..],
        ),
        (
            "sports",
            &[
                "运动",
                "健身",
                "跑步",
                "球赛",
                "体育",
                "篮球",
                "足球",
                "羽毛球",
                "乒乓球",
                "sports",
            ][..],
        ),
        (
            "work-growth",
            &[
                "工作", "职场", "求职", "招聘", "岗位", "学习", "成长", "职业", "效率",
            ][..],
        ),
        (
            "daily-life",
            &[
                "日常",
                "生活",
                "家务",
                "天气",
                "健康",
                "作息",
                "养生",
                "通勤",
                "lifestyle",
            ][..],
        ),
    ] {
        if needles.iter().any(|needle| value.contains(needle)) {
            add(&mut categories, category);
        }
    }
    if ["科学", "科普", "太空", "航天", "宇宙", "science", "space"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        add(&mut categories, "science");
    }
    categories
}

fn requested_categories(request: &FreshTopicQuery) -> Vec<String> {
    let explicit: Vec<String> = request
        .categories
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| VALID_CATEGORIES.contains(&value.as_str()))
        .collect();
    if explicit.is_empty() {
        query_categories(&request.query)
            .into_iter()
            .map(str::to_string)
            .collect()
    } else {
        explicit
    }
}

fn generic_category_rank(category: &str) -> u8 {
    match category {
        "daily-life" | "food" | "travel" => 0,
        "music" | "film-tv" | "books" | "sports" => 1,
        "general" => 2,
        _ => 3,
    }
}

fn preference_category(topic: &str) -> Option<&'static str> {
    let compact = topic.trim().to_lowercase();
    DEFAULT_TOPIC_PREFERENCES
        .iter()
        .find_map(|(label, category)| (*label == topic.trim()).then_some(*category))
        .or_else(|| query_categories(&compact).into_iter().next())
}

fn preference_quotas(values: &[super::TopicPreference]) -> BTreeMap<String, usize> {
    let mut quotas = BTreeMap::new();
    if values.is_empty() {
        for (_, category) in DEFAULT_TOPIC_PREFERENCES {
            quotas.insert((*category).into(), 10);
        }
        return quotas;
    }
    for preference in values {
        let Some(category) = preference_category(&preference.topic) else {
            continue;
        };
        let quota = match preference.status.as_str() {
            "interested" => 15,
            "neutral" => 10,
            "not-interested" => 0,
            _ => continue,
        };
        if quota == 0 {
            quotas.remove(category);
        } else {
            quotas
                .entry(category.into())
                .and_modify(|current| *current = (*current).max(quota))
                .or_insert(quota);
        }
    }
    quotas
}

fn category_source_priority(category: &str, source_name: &str) -> u8 {
    if category == "food" && source_name == "城市餐饮搜索" && !location_hints().is_empty() {
        return 0;
    }
    match (category, source_name) {
        ("film-tv", "豆瓣电影") => 0,
        ("film-tv", "百度热榜") => 8,
        ("books", "百度热榜") => 8,
        (
            "games",
            "Steam 限时免费"
            | "Steam 热门榜"
            | "App Store 新游"
            | "App Store 游戏榜"
            | "Steam 新游"
            | "Epic 限免",
        ) => 0,
        ("games", "哔哩哔哩热门") => 2,
        ("music", "汽水音乐") => 0,
        ("music", "网易云音乐") => 1,
        ("food", "携程餐厅榜") => 1,
        ("food", "城市餐饮搜索") => 2,
        ("travel", "携程景点榜") => 0,
        ("technology", "IT之家 RSS") => 0,
        ("daily-life" | "sports", "中新网 RSS") => 8,
        (_, "百度热榜") => 8,
        (_, "中新网 RSS") => 8,
        ("work-growth", "哔哩哔哩热门") => 0,
        ("food" | "travel", "哔哩哔哩热门") => 2,
        (_, "必应分类搜索") => 9,
        _ => 4,
    }
}

fn apply_category_quotas(
    items: Vec<FreshTopic>,
    quotas: &BTreeMap<String, usize>,
) -> Vec<FreshTopic> {
    let items = normalize_topics_unbounded(items);
    let mut result = Vec::new();
    for (category, limit) in quotas {
        let mut daily_families: BTreeMap<String, usize> = BTreeMap::new();
        let mut sources: BTreeMap<String, Vec<FreshTopic>> = BTreeMap::new();
        for item in items.iter().filter(|item| &item.category == category) {
            sources
                .entry(item.source_name.clone())
                .or_default()
                .push(item.clone());
        }
        let mut queues: Vec<(String, Vec<FreshTopic>, usize)> = sources
            .into_iter()
            .map(|(name, items)| (name, items, 0))
            .collect();
        let mut selected = 0usize;
        while selected < *limit {
            let mut active: Vec<usize> = queues
                .iter()
                .enumerate()
                .filter_map(|(index, (_, items, cursor))| (*cursor < items.len()).then_some(index))
                .collect();
            if active.is_empty() {
                break;
            }
            active.sort_by(|left, right| {
                let left_item = &queues[*left].1[queues[*left].2];
                let right_item = &queues[*right].1[queues[*right].2];
                category_source_priority(category, &left_item.source_name)
                    .cmp(&category_source_priority(category, &right_item.source_name))
                    .then_with(|| {
                        topic_time(right_item)
                            .cmp(topic_time(left_item))
                            .then_with(|| queues[*left].0.cmp(&queues[*right].0))
                    })
            });
            let index = if category == "games" {
                let best_priority = category_source_priority(
                    category,
                    &queues[active[0]].1[queues[active[0]].2].source_name,
                );
                let primary: Vec<_> = active
                    .into_iter()
                    .filter(|candidate| {
                        category_source_priority(
                            category,
                            &queues[*candidate].1[queues[*candidate].2].source_name,
                        ) == best_priority
                    })
                    .collect();
                let desired = if selected % 2 == 0 { "new" } else { "free" };
                let mut matching: Vec<_> = primary
                    .iter()
                    .copied()
                    .filter(|candidate| {
                        let source = queues[*candidate].1[queues[*candidate].2]
                            .source_name
                            .as_str();
                        matches!(
                            (desired, source),
                            ("new", "Steam 新游")
                                | ("free", "Steam 限时免费" | "Epic 限免")
                                | ("popular", "Steam 热门榜" | "App Store 游戏榜")
                        )
                    })
                    .collect();
                if desired == "popular" {
                    let mobile_first = (selected / 3) % 2 == 1;
                    matching.sort_by_key(|candidate| {
                        let source = queues[*candidate].1[queues[*candidate].2]
                            .source_name
                            .as_str();
                        match (mobile_first, source) {
                            (false, "Steam 热门榜") | (true, "App Store 游戏榜") => 0,
                            _ => 1,
                        }
                    });
                }
                matching
                    .first()
                    .copied()
                    .unwrap_or(primary[selected % primary.len()])
            } else {
                active[0]
            };
            let cursor = queues[index].2;
            let candidate = queues[index].1[cursor].clone();
            queues[index].2 += 1;
            if let Some(family) = daily_event_family(&candidate) {
                let count = daily_families.entry(family).or_default();
                if *count >= 2 {
                    continue;
                }
                *count += 1;
            }
            result.push(candidate);
            selected += 1;
        }
    }
    normalize_topics(result)
}

fn provider_pool_items(
    items: Vec<FreshTopic>,
    quotas: &BTreeMap<String, usize>,
) -> Vec<FreshTopic> {
    let mut items: Vec<_> = normalize_topics_unbounded(items)
        .into_iter()
        .filter(|item| quotas.contains_key(&item.category) && is_category_object_candidate(item))
        .collect();
    items.truncate(PROVIDER_POOL_MAX_ITEMS);
    items
}

#[allow(dead_code)]
pub struct HackerNewsSource;

impl FreshTopicSource for HackerNewsSource {
    fn id(&self) -> &'static str {
        "hacker-news"
    }

    fn name(&self) -> &'static str {
        "Hacker News"
    }

    fn categories(&self) -> &'static [&'static str] {
        &["technology"]
    }

    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        _quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        const TOP_STORIES_URL: &str = "https://hacker-news.firebaseio.com/v0/topstories.json";
        const ITEM_URL_PREFIX: &str = "https://hacker-news.firebaseio.com/v0/item/";
        let response = match client.get(TOP_STORIES_URL).send() {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                return FreshTopicSourceResult {
                    status: classify_http_status(response.status()).into(),
                    items: Vec::new(),
                }
            }
            Err(error) => {
                return FreshTopicSourceResult {
                    status: classify_request_error(&error).into(),
                    items: Vec::new(),
                }
            }
        };
        let ids: Vec<u64> = match response.json() {
            Ok(ids) => ids,
            Err(_) => {
                return FreshTopicSourceResult {
                    status: "provider_error".into(),
                    items: Vec::new(),
                }
            }
        };
        let mut items = Vec::new();
        let mut had_error = false;
        for id in ids.into_iter().take(16) {
            let response = match client.get(format!("{ITEM_URL_PREFIX}{id}.json")).send() {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    had_error = true;
                    let _ = classify_http_status(response.status());
                    continue;
                }
                Err(_) => {
                    had_error = true;
                    continue;
                }
            };
            let payload: serde_json::Value = match response.json() {
                Ok(payload) => payload,
                Err(_) => {
                    had_error = true;
                    continue;
                }
            };
            if let Some(topic) = parse_hacker_news_story(&payload, fetched_at) {
                items.push(topic);
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                if had_error {
                    "provider_error"
                } else {
                    "empty"
                }
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct ChinaNewsSource;

fn china_news_feed_requested(url: &str, quotas: &BTreeMap<String, usize>) -> bool {
    if url.ends_with("sports.xml") {
        quotas.contains_key("sports")
    } else if url.ends_with("culture.xml") {
        ["film-tv", "music", "books"]
            .iter()
            .any(|category| quotas.contains_key(*category))
    } else if url.ends_with("health.xml") || url.ends_with("society.xml") {
        quotas.contains_key("daily-life")
    } else {
        ["daily-life", "food", "travel"]
            .iter()
            .any(|category| quotas.contains_key(*category))
    }
}

impl FreshTopicSource for ChinaNewsSource {
    fn id(&self) -> &'static str {
        "china-news-rss"
    }

    fn name(&self) -> &'static str {
        "中新网 RSS"
    }

    fn categories(&self) -> &'static [&'static str] {
        &[
            "daily-life",
            "food",
            "travel",
            "music",
            "film-tv",
            "books",
            "sports",
        ]
    }

    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        const FEEDS: &[(&str, Option<&str>)] = &[
            (
                "https://www.chinanews.com.cn/rss/life.xml",
                Some("daily-life"),
            ),
            ("https://www.chinanews.com.cn/rss/culture.xml", None),
            (
                "https://www.chinanews.com.cn/rss/health.xml",
                Some("daily-life"),
            ),
            (
                "https://www.chinanews.com.cn/rss/sports.xml",
                Some("sports"),
            ),
            (
                "https://www.chinanews.com.cn/rss/society.xml",
                Some("daily-life"),
            ),
        ];
        let mut items = Vec::new();
        let mut statuses: Vec<String> = Vec::new();
        for (url, default_category) in FEEDS
            .iter()
            .filter(|(url, _)| china_news_feed_requested(url, quotas))
        {
            match source_http_result(client.get(*url).send()) {
                Ok(body) => {
                    let parsed = parse_rss_items(
                        &body,
                        self.id(),
                        self.name(),
                        *default_category,
                        fetched_at,
                    );
                    statuses.push(
                        if parsed.is_empty() {
                            "parse_error"
                        } else {
                            "ok"
                        }
                        .into(),
                    );
                    items.extend(parsed);
                }
                Err(status) => statuses.push(status),
            }
        }
        FreshTopicSourceResult {
            status: if !items.is_empty() {
                if statuses.iter().all(|status| status == "ok") {
                    "ok"
                } else {
                    "partial"
                }
            } else {
                statuses
                    .first()
                    .map(String::as_str)
                    .unwrap_or("provider_error")
            }
            .into(),
            items,
        }
    }
}

pub struct BaiduHotSource;

fn baidu_board_requested(board: &str, quotas: &BTreeMap<String, usize>) -> bool {
    match board {
        "movie" | "teleplay" => quotas.contains_key("film-tv"),
        "novel" => quotas.contains_key("books"),
        _ => ["daily-life", "food", "travel", "sports"]
            .iter()
            .any(|category| quotas.contains_key(*category)),
    }
}

fn collect_baidu_entries(
    value: &serde_json::Value,
    forced_category: Option<&str>,
    fetched_at: &str,
    items: &mut Vec<FreshTopic>,
) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                collect_baidu_entries(value, forced_category, fetched_at, items);
            }
        }
        serde_json::Value::Object(object) => {
            let title = object
                .get("word")
                .or_else(|| object.get("title"))
                .and_then(|value| value.as_str());
            let url = object.get("url").and_then(|value| value.as_str());
            if let (Some(title), Some(raw_url)) = (title, url) {
                let classified = classify_category(title);
                let category = forced_category.unwrap_or(classified);
                if category != "general" {
                    if let Some(canonical_url) = canonicalize_url(raw_url) {
                        let short_text = object
                            .get("desc")
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or(title);
                        if let Some(topic) = normalized_topic(FreshTopic {
                            source_id: format!(
                                "baidu-hot:{:016x}",
                                fnv1a64(canonical_url.as_bytes())
                            ),
                            source_name: "百度热榜".into(),
                            canonical_url,
                            title: title.into(),
                            published_at: None,
                            fetched_at: fetched_at.into(),
                            short_text: short_text.into(),
                            category: category.into(),
                            locale: "zh-CN".into(),
                        }) {
                            items.push(topic);
                        }
                    }
                }
            }
            for value in object.values() {
                collect_baidu_entries(value, forced_category, fetched_at, items);
            }
        }
        _ => {}
    }
}

impl FreshTopicSource for BaiduHotSource {
    fn id(&self) -> &'static str {
        "baidu-hot"
    }

    fn name(&self) -> &'static str {
        "百度热榜"
    }

    fn categories(&self) -> &'static [&'static str] {
        &["daily-life", "film-tv", "books", "food", "travel", "sports"]
    }

    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        const BOARDS: &[(&str, Option<&str>)] = &[
            ("realtime", None),
            ("movie", Some("film-tv")),
            ("teleplay", Some("film-tv")),
            ("novel", Some("books")),
        ];
        let mut items = Vec::new();
        let mut failures = 0usize;
        for (board, category) in BOARDS
            .iter()
            .filter(|(board, _)| baidu_board_requested(board, quotas))
        {
            let body = source_http_result(
                client
                    .get("https://top.baidu.com/api/board")
                    .query(&[("platform", "pc"), ("tab", *board)])
                    .send(),
            );
            let Ok(body) = body else {
                failures += 1;
                continue;
            };
            let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
                failures += 1;
                continue;
            };
            if payload.get("success").and_then(|value| value.as_bool()) != Some(true) {
                failures += 1;
                continue;
            }
            collect_baidu_entries(&payload["data"]["cards"], *category, fetched_at, &mut items);
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "provider_error"
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct BilibiliPopularSource;

fn bilibili_category(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if ["日常", "亲子", "家居房产", "手工"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("daily-life")
    } else if ["出行", "旅行"].iter().any(|item| value.contains(item)) {
        Some("travel")
    } else if value.contains("美食") {
        Some("food")
    } else if ["音乐", "演奏", "乐评"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("music")
    } else if ["影视", "电影", "动画", "小剧场", "纪录片"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("film-tv")
    } else if ["游戏", "电竞"].iter().any(|item| value.contains(item)) {
        Some("games")
    } else if ["数码", "科技", "计算机", "科工"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("technology")
    } else if ["运动", "篮球", "足球", "健身"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("sports")
    } else if ["校园学习", "职业职场", "社科", "财经商业", "知识"]
        .iter()
        .any(|item| value.contains(item))
    {
        Some("work-growth")
    } else {
        None
    }
}

impl FreshTopicSource for BilibiliPopularSource {
    fn id(&self) -> &'static str {
        "bilibili-popular"
    }

    fn name(&self) -> &'static str {
        "哔哩哔哩热门"
    }

    fn categories(&self) -> &'static [&'static str] {
        &[
            "daily-life",
            "food",
            "travel",
            "music",
            "film-tv",
            "games",
            "technology",
            "sports",
            "work-growth",
        ]
    }

    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let body = match source_http_result(
            client
                .get("https://api.bilibili.com/x/web-interface/popular")
                .query(&[("ps", "50"), ("pn", "1")])
                .send(),
        ) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                };
            }
        };
        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        if payload.get("code").and_then(|value| value.as_i64()) != Some(0) {
            return FreshTopicSourceResult {
                status: "schema_changed".into(),
                items: Vec::new(),
            };
        }
        let mut items = Vec::new();
        for item in payload
            .pointer("/data/list")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .take(50)
        {
            let Some(title) = item.get("title").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(category) = item
                .get("tname")
                .and_then(|value| value.as_str())
                .and_then(bilibili_category)
            else {
                continue;
            };
            let Some(bvid) = item
                .get("bvid")
                .and_then(|value| value.as_str())
                .filter(|value| value.starts_with("BV"))
            else {
                continue;
            };
            let published_at = item
                .get("pubdate")
                .and_then(|value| value.as_i64())
                .and_then(|timestamp| chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0))
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            let short_text = item
                .get("desc")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(title);
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!("bilibili:{bvid}"),
                source_name: self.name().into(),
                canonical_url: format!("https://www.bilibili.com/video/{bvid}"),
                title: title.into(),
                published_at,
                fetched_at: fetched_at.into(),
                short_text: short_text.into(),
                category: category.into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
        }
        let mut region_failed = false;
        let food_limit = quotas.get("food").copied().unwrap_or(0).min(15);
        if food_limit > 0
            && items.iter().filter(|item| item.category == "food").count() < food_limit
        {
            match source_http_result(
                client
                    .get("https://api.bilibili.com/x/web-interface/ranking/region")
                    .query(&[("rid", "76"), ("day", "3"), ("original", "0")])
                    .send(),
            )
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
            {
                Some(region) if region.get("code").and_then(|value| value.as_i64()) == Some(0) => {
                    for (index, item) in region
                        .get("data")
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten()
                        .take(50)
                        .enumerate()
                    {
                        let Some(title) = item.get("title").and_then(|value| value.as_str()) else {
                            continue;
                        };
                        let Some(bvid) = item
                            .get("bvid")
                            .and_then(|value| value.as_str())
                            .filter(|value| value.starts_with("BV"))
                        else {
                            continue;
                        };
                        let description = item
                            .get("description")
                            .or_else(|| item.get("desc"))
                            .and_then(|value| value.as_str())
                            .and_then(|value| rss_summary_text(value, title))
                            .unwrap_or_else(|| {
                                format!(
                                    "B站美食热榜第 {} 名，视频围绕这道菜品或做法展开：{title}",
                                    index + 1
                                )
                            });
                        let published_at = item
                            .get("pubdate")
                            .and_then(|value| value.as_i64())
                            .and_then(|timestamp| {
                                chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
                            })
                            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                        if let Some(topic) = normalized_topic(FreshTopic {
                            source_id: format!("bilibili-food:{bvid}"),
                            source_name: self.name().into(),
                            canonical_url: format!("https://www.bilibili.com/video/{bvid}"),
                            title: title.into(),
                            published_at,
                            fetched_at: fetched_at.into(),
                            short_text: description,
                            category: "food".into(),
                            locale: "zh-CN".into(),
                        }) {
                            items.push(topic);
                        }
                    }
                }
                _ => region_failed = true,
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "empty"
            } else if region_failed {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct ItHomeSource;

impl FreshTopicSource for ItHomeSource {
    fn id(&self) -> &'static str {
        "ithome-rss"
    }
    fn name(&self) -> &'static str {
        "IT之家 RSS"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["technology", "science", "games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        _quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let body = match source_http_result(client.get("https://www.ithome.com/rss/").send()) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let items = parse_rss_items(
            &body,
            self.id(),
            self.name(),
            Some("technology"),
            fetched_at,
        );
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct SteamPopularSource;
pub struct SteamNewReleasesSource;
pub struct SteamFreeGamesSource;
pub struct EpicFreeGamesSource;
pub struct AppleGameChartSource;

fn windows_1252_byte(character: char) -> Option<u8> {
    match character {
        '\u{20ac}' => Some(0x80),
        '\u{201a}' => Some(0x82),
        '\u{0192}' => Some(0x83),
        '\u{201e}' => Some(0x84),
        '\u{2026}' => Some(0x85),
        '\u{2020}' => Some(0x86),
        '\u{2021}' => Some(0x87),
        '\u{02c6}' => Some(0x88),
        '\u{2030}' => Some(0x89),
        '\u{0160}' => Some(0x8a),
        '\u{2039}' => Some(0x8b),
        '\u{0152}' => Some(0x8c),
        '\u{017d}' => Some(0x8e),
        '\u{2018}' => Some(0x91),
        '\u{2019}' => Some(0x92),
        '\u{201c}' => Some(0x93),
        '\u{201d}' => Some(0x94),
        '\u{2022}' => Some(0x95),
        '\u{2013}' => Some(0x96),
        '\u{2014}' => Some(0x97),
        '\u{02dc}' => Some(0x98),
        '\u{2122}' => Some(0x99),
        '\u{0161}' => Some(0x9a),
        '\u{203a}' => Some(0x9b),
        '\u{0153}' => Some(0x9c),
        '\u{017e}' => Some(0x9e),
        '\u{0178}' => Some(0x9f),
        value if u32::from(value) <= 0xff => Some(value as u8),
        _ => None,
    }
}

fn repair_utf8_mojibake(value: &str) -> String {
    let bytes: Option<Vec<_>> = value.chars().map(windows_1252_byte).collect();
    let Some(repaired) = bytes.and_then(|bytes| String::from_utf8(bytes).ok()) else {
        return value.to_string();
    };
    let cjk = |text: &str| {
        text.chars()
            .filter(|character| matches!(*character, '\u{3400}'..='\u{9fff}'))
            .count()
    };
    if cjk(&repaired) > cjk(value) {
        repaired
    } else {
        value.to_string()
    }
}

fn steam_topic_from_detail(
    app_id: u64,
    rank: usize,
    peak_players: u64,
    detail: &serde_json::Value,
    fetched_at: &str,
) -> Option<FreshTopic> {
    let data = detail.get(app_id.to_string())?.get("data")?;
    let title = repair_utf8_mojibake(data.get("name")?.as_str()?);
    let raw_intro = repair_utf8_mojibake(data.get("short_description")?.as_str()?);
    let intro = rss_summary_text(&raw_intro, &title)?;
    normalized_topic(FreshTopic {
        source_id: format!("steam-chart:{app_id}"),
        source_name: "Steam 热门榜".into(),
        canonical_url: format!("https://store.steampowered.com/app/{app_id}/"),
        title,
        published_at: None,
        fetched_at: fetched_at.into(),
        short_text: format!("Steam 热门第 {rank} 名，在线峰值约 {peak_players} 人；{intro}"),
        category: "games".into(),
        locale: "zh-CN".into(),
    })
}

impl FreshTopicSource for SteamPopularSource {
    fn id(&self) -> &'static str {
        "steam-popular"
    }
    fn name(&self) -> &'static str {
        "Steam 热门榜"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let limit = quotas.get("games").copied().unwrap_or(0).min(15);
        if limit == 0 {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let chart_url = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/";
        let chart_body = source_http_result(client.get(chart_url).send()).or_else(|status| {
            if status == "timeout" || status == "unavailable" {
                source_http_result(client.get(chart_url).send())
            } else {
                Err(status)
            }
        });
        let chart = match chart_body {
            Ok(body) => match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(value) => value,
                Err(_) => {
                    return FreshTopicSourceResult {
                        status: "parse_error".into(),
                        items: Vec::new(),
                    }
                }
            },
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let Some(ranks) = chart
            .pointer("/response/ranks")
            .and_then(|value| value.as_array())
        else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let mut items = Vec::new();
        let mut failures = 0usize;
        for ranked in ranks.iter().take((limit * 2).min(16)) {
            if items.len() >= limit {
                break;
            }
            let Some(app_id) = ranked.get("appid").and_then(|value| value.as_u64()) else {
                continue;
            };
            let rank = ranked
                .get("rank")
                .and_then(|value| value.as_u64())
                .unwrap_or((items.len() + 1) as u64) as usize;
            let peak = ranked
                .get("peak_in_game")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let detail = source_http_result(
                client
                    .get("https://store.steampowered.com/api/appdetails")
                    .query(&[
                        ("appids", app_id.to_string()),
                        ("l", "schinese".into()),
                        ("cc", "CN".into()),
                    ])
                    .send(),
            )
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok());
            if let Some(topic) = detail
                .as_ref()
                .and_then(|detail| steam_topic_from_detail(app_id, rank, peak, detail, fetched_at))
            {
                items.push(topic);
            } else {
                failures += 1;
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "provider_error"
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

impl FreshTopicSource for SteamFreeGamesSource {
    fn id(&self) -> &'static str {
        "steam-free-games"
    }
    fn name(&self) -> &'static str {
        "Steam 限时免费"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let limit = quotas.get("games").copied().unwrap_or(0).min(15);
        if limit == 0 {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match source_http_result(
            client
                .get("https://store.steampowered.com/search/results/")
                .query(&[
                    ("start", "0"),
                    ("count", "50"),
                    ("sort_by", "Released_DESC"),
                    ("supportedlang", "schinese"),
                    ("infinite", "1"),
                    ("filter", "weekfree"),
                ])
                .send(),
        ) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let html = payload
            .get("results_html")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut items = Vec::new();
        for (rank, tail) in html.split("data-ds-appid=\"").skip(1).enumerate() {
            if items.len() >= limit {
                break;
            }
            let Some(app_id) = tail
                .split('"')
                .next()
                .and_then(|raw| raw.split(',').next())
                .and_then(|raw| raw.parse::<u64>().ok())
            else {
                continue;
            };
            let detail = source_http_result(
                client
                    .get("https://store.steampowered.com/api/appdetails")
                    .query(&[
                        ("appids", app_id.to_string()),
                        ("l", "schinese".into()),
                        ("cc", "CN".into()),
                    ])
                    .send(),
            )
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok());
            let Some(data) = detail
                .as_ref()
                .and_then(|value| value.get(app_id.to_string()))
                .and_then(|value| value.get("data"))
            else {
                continue;
            };
            let Some(title) = data.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(intro) = data
                .get("short_description")
                .and_then(|value| value.as_str())
                .and_then(|value| rss_summary_text(value, title))
            else {
                continue;
            };
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!("steam-free:{app_id}"),
                source_name: self.name().into(),
                canonical_url: format!(
                    "https://store.steampowered.com/app/{app_id}/?kxyy=limited-free"
                ),
                title: format!("{}（限时免费）", repair_utf8_mojibake(title)),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: format!("Steam 限时免费第 {} 项；{}", rank + 1, intro),
                category: "games".into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

impl FreshTopicSource for SteamNewReleasesSource {
    fn id(&self) -> &'static str {
        "steam-new-releases"
    }
    fn name(&self) -> &'static str {
        "Steam 新游"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let limit = quotas.get("games").copied().unwrap_or(0).min(15);
        if limit == 0 {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match source_http_result(
            client
                .get("https://store.steampowered.com/search/results/")
                .query(&[
                    ("start", "0"),
                    ("count", "20"),
                    ("sort_by", "Released_DESC"),
                    ("supportedlang", "schinese"),
                    ("infinite", "1"),
                ])
                .send(),
        ) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let payload: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(payload) => payload,
            Err(_) => {
                return FreshTopicSourceResult {
                    status: "parse_error".into(),
                    items: Vec::new(),
                }
            }
        };
        let html = payload
            .get("results_html")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut app_ids = Vec::new();
        for tail in html.split("data-ds-appid=\"").skip(1) {
            let Some(raw) = tail.split('"').next() else {
                continue;
            };
            let Some(app_id) = raw
                .split(',')
                .next()
                .and_then(|value| value.parse::<u64>().ok())
            else {
                continue;
            };
            if !app_ids.contains(&app_id) {
                app_ids.push(app_id);
            }
            if app_ids.len() >= limit * 2 {
                break;
            }
        }
        let mut items = Vec::new();
        for app_id in app_ids {
            let detail = source_http_result(
                client
                    .get("https://store.steampowered.com/api/appdetails")
                    .query(&[
                        ("appids", app_id.to_string()),
                        ("l", "schinese".into()),
                        ("cc", "CN".into()),
                    ])
                    .send(),
            )
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok());
            let Some(data) = detail
                .as_ref()
                .and_then(|value| value.get(app_id.to_string()))
                .and_then(|value| value.get("data"))
            else {
                continue;
            };
            let Some(title) = data.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(intro) = data
                .get("short_description")
                .and_then(|value| value.as_str())
                .and_then(|value| rss_summary_text(value, title))
            else {
                continue;
            };
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!("steam-new:{app_id}"),
                source_name: self.name().into(),
                canonical_url: format!("https://store.steampowered.com/app/{app_id}/"),
                title: repair_utf8_mojibake(title),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: format!("Steam 近期新上架；{intro}"),
                category: "games".into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
            if items.len() >= limit {
                break;
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

impl FreshTopicSource for EpicFreeGamesSource {
    fn id(&self) -> &'static str {
        "epic-free-games"
    }
    fn name(&self) -> &'static str {
        "Epic 限免"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("games") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match client
            .get("https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions")
            .query(&[
                ("locale", "zh-CN"),
                ("country", "CN"),
                ("allowCountries", "CN"),
            ])
            .send()
            .map_err(|error| classify_request_error(&error).to_string())
            .and_then(|response| {
                if response.status().is_success() {
                    read_response_bounded_with_limit(response, 8 * 1024 * 1024)
                } else {
                    Err(classify_http_status(response.status()).into())
                }
            }) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let payload: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(payload) => payload,
            Err(_) => {
                return FreshTopicSourceResult {
                    status: "parse_error".into(),
                    items: Vec::new(),
                }
            }
        };
        let now = chrono::DateTime::parse_from_rfc3339(fetched_at).ok();
        let mut items = Vec::new();
        for game in payload
            .pointer("/data/Catalog/searchStore/elements")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
        {
            let Some(title) = game.get("title").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(description) = game
                .get("description")
                .and_then(|value| value.as_str())
                .and_then(|value| rss_summary_text(value, title))
            else {
                continue;
            };
            let offers = game
                .pointer("/promotions/promotionalOffers")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .chain(
                    game.pointer("/promotions/upcomingPromotionalOffers")
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten(),
                );
            let mut free_window = None;
            for offer_group in offers {
                for offer in offer_group
                    .get("promotionalOffers")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                {
                    if offer
                        .pointer("/discountSetting/discountPercentage")
                        .and_then(|value| value.as_i64())
                        != Some(0)
                    {
                        continue;
                    }
                    let start = offer
                        .get("startDate")
                        .and_then(|value| value.as_str())
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
                    let end = offer
                        .get("endDate")
                        .and_then(|value| value.as_str())
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
                    if let (Some(now), Some(start), Some(end)) = (now, start, end) {
                        if now >= start && now <= end {
                            free_window = Some(end);
                        }
                    }
                }
            }
            let Some(end) = free_window else { continue };
            let slug = game
                .get("productSlug")
                .or_else(|| game.get("urlSlug"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    game.pointer("/offerMappings/0/pageSlug")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("");
            if slug.is_empty() {
                continue;
            }
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!(
                    "epic-free:{}",
                    game.get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or(slug)
                ),
                source_name: self.name().into(),
                canonical_url: format!("https://store.epicgames.com/zh-CN/p/{slug}"),
                title: title.into(),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: format!(
                    "Epic 当前免费领取，截止 {}；{description}",
                    end.format("%m-%d %H:%M")
                ),
                category: "games".into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

fn ios_game_intro(value: &str, title: &str) -> Option<String> {
    let value = value.replace('\r', "");
    let value = value
        .split_once("【游戏介绍】")
        .map(|(_, intro)| intro)
        .unwrap_or(&value);
    let value = value.split("\n【").next().unwrap_or(value);
    rss_summary_text(value, title)
}

fn parse_apple_game_chart(
    payload: &serde_json::Value,
    fetched_at: &str,
    limit: usize,
) -> Vec<FreshTopic> {
    payload
        .pointer("/feed/entry")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take((limit * 8).min(200))
        .enumerate()
        .filter_map(|(index, entry)| {
            let title = entry.pointer("/im:name/label")?.as_str()?;
            let app_id = entry
                .pointer("/id/attributes/im:id")
                .or_else(|| entry.pointer("/id/label"))?
                .as_str()?;
            let url = entry
                .get("link")
                .and_then(|value| {
                    value
                        .as_array()
                        .and_then(|links| {
                            links.iter().find(|link| {
                                link.pointer("/attributes/rel")
                                    .and_then(|value| value.as_str())
                                    == Some("alternate")
                            })
                        })
                        .or(Some(value))
                })
                .and_then(|link| link.pointer("/attributes/href"))
                .and_then(|value| value.as_str())?;
            let is_game = entry
                .pointer("/category/attributes/im:id")
                .and_then(|value| value.as_str())
                .map(|value| value == "6014")
                .or_else(|| {
                    entry
                        .pointer("/category/attributes/label")
                        .and_then(|value| value.as_str())
                        .map(|value| value.contains("游戏"))
                })
                .unwrap_or(true);
            if !is_game {
                return None;
            }
            let intro = entry
                .pointer("/summary/label")
                .and_then(|value| value.as_str())
                .and_then(|value| ios_game_intro(value, title))
                .or_else(|| {
                    entry
                        .pointer("/im:releaseDate/attributes/label")
                        .and_then(|value| value.as_str())
                        .map(|date| format!("新游，发布日期 {date}"))
                })?;
            normalized_topic(FreshTopic {
                source_id: format!("app-store-game:{app_id}"),
                source_name: "App Store 新游".into(),
                canonical_url: url.into(),
                title: title.into(),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: format!("App Store 新游第 {} 名；{intro}", index + 1),
                category: "games".into(),
                locale: "zh-CN".into(),
            })
        })
        .collect()
}

impl FreshTopicSource for AppleGameChartSource {
    fn id(&self) -> &'static str {
        "app-store-new-games"
    }
    fn name(&self) -> &'static str {
        "App Store 新游"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["games"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let limit = quotas.get("games").copied().unwrap_or(0).min(15);
        if limit == 0 {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match client
            .get("https://itunes.apple.com/cn/rss/newapplications/limit=200/genre=6014/json")
            .send()
            .map_err(|error| classify_request_error(&error).to_string())
            .and_then(|response| {
                if response.status().is_success() {
                    read_response_bounded_with_limit(response, 8 * 1024 * 1024)
                } else {
                    Err(classify_http_status(response.status()).into())
                }
            }) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let payload = match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(payload) => payload,
            Err(_) => {
                return FreshTopicSourceResult {
                    status: "parse_error".into(),
                    items: Vec::new(),
                }
            }
        };
        let items = parse_apple_game_chart(&payload, fetched_at, limit);
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct DoubanMovieSource;

fn html_attr_after<'a>(value: &'a str, marker: &str, attribute: &str) -> Option<&'a str> {
    let tail = &value[value.find(marker)?..];
    let prefix = format!("{attribute}=\"");
    let start = tail.find(&prefix)? + prefix.len();
    let tail = &tail[start..];
    Some(&tail[..tail.find('"')?])
}

fn html_fragment_after<'a>(value: &'a str, marker: &str, end: &str) -> Option<&'a str> {
    let tail = &value[value.find(marker)? + marker.len()..];
    Some(&tail[..tail.find(end)?])
}

fn douban_movie_topic(
    title: &str,
    url: &str,
    rating: Option<&str>,
    detail: &serde_json::Value,
    fetched_at: &str,
) -> Option<FreshTopic> {
    let intro = rss_summary_text(detail.get("intro")?.as_str()?, title)?;
    let summary = match rating.filter(|value| !value.is_empty()) {
        Some(rating) => format!("豆瓣评分 {rating}；{intro}"),
        None => intro,
    };
    normalized_topic(FreshTopic {
        source_id: format!("douban-movie:{:016x}", fnv1a64(url.as_bytes())),
        source_name: "豆瓣电影".into(),
        canonical_url: url.into(),
        title: title.into(),
        published_at: None,
        fetched_at: fetched_at.into(),
        short_text: summary,
        category: "film-tv".into(),
        locale: "zh-CN".into(),
    })
}

impl FreshTopicSource for DoubanMovieSource {
    fn id(&self) -> &'static str {
        "douban-movie"
    }
    fn name(&self) -> &'static str {
        "豆瓣电影"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["film-tv"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("film-tv") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match source_http_result(client.get("https://movie.douban.com/chart").send()) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let Ok(html) = std::str::from_utf8(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let limit = quotas.get("film-tv").copied().unwrap_or(0).min(10);
        let mut items = Vec::new();
        let mut failures = 0usize;
        for row in html.split("<tr class=\"item\">").skip(1).take(limit * 2) {
            if items.len() >= limit {
                break;
            }
            let Some(title) = html_attr_after(row, "class=\"nbg\"", "title") else {
                continue;
            };
            let Some(url) =
                html_attr_after(row, "class=\"nbg\"", "href").and_then(canonicalize_url)
            else {
                continue;
            };
            let rating = html_fragment_after(row, "class=\"rating_nums\">", "</span>")
                .map(|value| compact_text(value, 12))
                .filter(|value| !value.is_empty());
            let Some(subject_id) = reqwest::Url::parse(&url).ok().and_then(|url| {
                url.path_segments()?
                    .find(|segment| segment.chars().all(|character| character.is_ascii_digit()))
                    .map(str::to_string)
            }) else {
                continue;
            };
            let detail = source_http_result(
                client
                    .get(format!(
                        "https://m.douban.com/rexxar/api/v2/movie/{subject_id}"
                    ))
                    .header(
                        reqwest::header::REFERER,
                        format!("https://m.douban.com/movie/subject/{subject_id}/"),
                    )
                    .send(),
            )
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok());
            if let Some(topic) = detail.as_ref().and_then(|detail| {
                douban_movie_topic(title, &url, rating.as_deref(), detail, fetched_at)
            }) {
                items.push(topic);
            } else {
                failures += 1;
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct NeteaseNewSongsSource;
pub struct SodaMusicSource;

fn soda_music_track_url(track_id: &str) -> String {
    // The upstream hot-content API returns numeric IDs; keep the URL fixed to
    // the share route used by the current 汽水音乐 web client.
    format!("https://music.douyin.com/qishui/share/track?track_id={track_id}")
}

impl FreshTopicSource for SodaMusicSource {
    fn id(&self) -> &'static str {
        "soda-music-hot"
    }
    fn name(&self) -> &'static str {
        "汽水音乐"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["music"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let limit = quotas.get("music").copied().unwrap_or(0).min(15);
        if limit == 0 {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match source_http_result(
            client
                .get("https://music.douyin.com/api/home/hot-content")
                .send(),
        ) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let mut items = Vec::new();
        for song in payload
            .pointer("/data/hotSongs")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .take(limit)
        {
            let Some(id) = song.get("songId").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(title) = song.get("title").and_then(|value| value.as_str()) else {
                continue;
            };
            let artist = song
                .get("artist")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let rank = song
                .get("rank")
                .and_then(|value| value.as_u64())
                .unwrap_or((items.len() + 1) as u64);
            let favorite = song
                .get("favoriteCountText")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let comments = song
                .get("commentCountText")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!("soda-song:{id}"),
                source_name: self.name().into(),
                canonical_url: soda_music_track_url(id),
                title: title.into(),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: format!(
                    "汽水音乐热歌榜第 {rank} 名；歌手：{artist}；收藏 {favorite}；评论 {comments}"
                ),
                category: "music".into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

impl FreshTopicSource for NeteaseNewSongsSource {
    fn id(&self) -> &'static str {
        "netease-new-songs"
    }
    fn name(&self) -> &'static str {
        "网易云音乐"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["music"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("music") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match source_http_result(
            client
                .get("https://music.163.com/api/playlist/detail?id=3779629")
                .send(),
        ) {
            Ok(body) => body,
            Err(status) => {
                return FreshTopicSourceResult {
                    status,
                    items: Vec::new(),
                }
            }
        };
        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let mut items = Vec::new();
        for (index, track) in payload
            .pointer("/result/tracks")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .take(50)
            .enumerate()
        {
            let Some(id) = track.get("id").and_then(|value| value.as_u64()) else {
                continue;
            };
            let Some(title) = track.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let artists = track
                .get("artists")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|artist| artist.get("name").and_then(|value| value.as_str()))
                .take(3)
                .collect::<Vec<_>>()
                .join("、");
            let album = track
                .pointer("/album/name")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let summary = format!(
                "新歌榜第 {} 名；歌手：{}{}",
                index + 1,
                artists,
                if album.is_empty() {
                    String::new()
                } else {
                    format!("；专辑：{album}")
                }
            );
            if let Some(topic) = normalized_topic(FreshTopic {
                source_id: format!("netease-song:{id}"),
                source_name: self.name().into(),
                canonical_url: format!("https://music.163.com/song?id={id}"),
                title: title.into(),
                published_at: None,
                fetched_at: fetched_at.into(),
                short_text: summary,
                category: "music".into(),
                locale: "zh-CN".into(),
            }) {
                items.push(topic);
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct BingCategorySearchSource;

pub struct CityDiningSearchSource;

impl FreshTopicSource for CityDiningSearchSource {
    fn id(&self) -> &'static str {
        "city-dining-search"
    }
    fn name(&self) -> &'static str {
        "城市餐饮搜索"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["food"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("food") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let mut cities = location_hints();
        // Settings/startup can prefetch before chat has published identity hints.
        // Keep a bounded nationwide fallback so this specialist is not empty solely
        // because the conversation window has not opened yet.
        if cities.is_empty() {
            cities.push("全国".into());
        }
        let mut items = Vec::new();
        let mut failures = 0usize;
        for city in cities {
            let query = if city == "全国" {
                "全国 热门餐厅 餐馆 探店 招牌菜 推荐 排名".to_string()
            } else {
                format!("{city} 必吃餐厅 餐馆 探店 招牌菜 推荐")
            };
            let body = source_http_result(
                client
                    .get("https://www.bing.com/search")
                    .query(&[("q", query.as_str()), ("format", "rss"), ("mkt", "zh-CN")])
                    .send(),
            );
            let Ok(body) = body else {
                failures += 1;
                continue;
            };
            let mut parsed =
                parse_rss_items(&body, self.id(), self.name(), Some("food"), fetched_at);
            for item in &mut parsed {
                item.category = "food".into();
                item.short_text = format!("{city}：{}", item.short_text);
            }
            items.extend(
                parsed
                    .into_iter()
                    .filter(is_category_object_candidate)
                    .take(12),
            );
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                if failures > 0 {
                    "provider_error"
                } else {
                    "empty"
                }
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

#[allow(dead_code)]
pub struct XiachufangPopularSource;

#[allow(dead_code)]
fn xiachufang_recipe_topic(
    url: &str,
    payload: &serde_json::Value,
    fetched_at: &str,
) -> Option<FreshTopic> {
    let title = payload.get("name")?.as_str()?;
    let description = rss_summary_text(payload.get("description")?.as_str()?, title)?;
    let category = payload
        .get("recipeCategory")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let rating = payload
        .pointer("/aggregateRating/ratingValue")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let mut details = vec![description];
    if let Some(category) = category {
        details.push(format!("分类：{category}"));
    }
    if let Some(rating) = rating {
        details.push(format!("评分 {rating}"));
    }
    normalized_topic(FreshTopic {
        source_id: format!("xiachufang:{:016x}", fnv1a64(url.as_bytes())),
        source_name: "下厨房".into(),
        canonical_url: url.into(),
        title: title.into(),
        published_at: None,
        fetched_at: fetched_at.into(),
        short_text: details.join("；"),
        category: "food".into(),
        locale: "zh-CN".into(),
    })
}

impl FreshTopicSource for XiachufangPopularSource {
    fn id(&self) -> &'static str {
        "xiachufang-popular"
    }
    fn name(&self) -> &'static str {
        "下厨房"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["food"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("food") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body =
            match source_http_result(client.get("https://www.xiachufang.com/explore/").send()) {
                Ok(body) => body,
                Err(status) => {
                    return FreshTopicSourceResult {
                        status,
                        items: Vec::new(),
                    }
                }
            };
        let Ok(html) = std::str::from_utf8(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let limit = quotas.get("food").copied().unwrap_or(0).min(15);
        let mut items = Vec::new();
        let mut failures = 0usize;
        for block in html
            .split("<div class=\"recipe recipe-215-horizontal")
            .skip(1)
            .take(limit * 2)
        {
            if items.len() >= limit {
                break;
            }
            let Some(path) = html_attr_after(block, "<a href=\"/recipe/", "href") else {
                continue;
            };
            let url = format!("https://www.xiachufang.com{path}");
            let detail = source_http_result(client.get(&url).send())
                .ok()
                .and_then(|body| String::from_utf8(body).ok())
                .and_then(|html| {
                    html_fragment_after(&html, "<script type=\"application/ld+json\">", "</script>")
                        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                });
            if let Some(topic) = detail
                .as_ref()
                .and_then(|payload| xiachufang_recipe_topic(&url, payload, fetched_at))
            {
                items.push(topic);
            } else {
                failures += 1;
            }
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

pub struct CtripAttractionsSource;
pub struct CtripDiningSource;

fn collect_ctrip_dining(value: &serde_json::Value, fetched_at: &str, items: &mut Vec<FreshTopic>) {
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .for_each(|value| collect_ctrip_dining(value, fetched_at, items)),
        serde_json::Value::Object(object) => {
            if let (Some(name), Some(id)) = (
                object.get("name").and_then(|value| value.as_str()),
                object.get("poiId").and_then(|value| value.as_u64()),
            ) {
                if let Some(url) = canonicalize_url(&format!(
                    "https://you.ctrip.com/yougourmet/restdetail/china110000/{id}.html"
                )) {
                    let address = object
                        .get("address")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let score = object.get("commentScore").and_then(|value| value.as_f64());
                    let price = object.get("averagePrice").and_then(|value| value.as_f64());
                    let mut summary = if address.is_empty() {
                        "携程热门餐厅".to_string()
                    } else {
                        format!("地址：{address}")
                    };
                    if let Some(score) = score {
                        summary.push_str(&format!("；评分 {score:.1}"));
                    }
                    if let Some(price) = price {
                        summary.push_str(&format!("；人均约 ¥{price:.0}"));
                    }
                    if let Some(topic) = normalized_topic(FreshTopic {
                        source_id: format!("ctrip-dining:{id}"),
                        source_name: "携程餐厅榜".into(),
                        canonical_url: url,
                        title: name.into(),
                        published_at: None,
                        fetched_at: fetched_at.into(),
                        short_text: summary,
                        category: "food".into(),
                        locale: "zh-CN".into(),
                    }) {
                        items.push(topic);
                    }
                }
            }
            object
                .values()
                .for_each(|value| collect_ctrip_dining(value, fetched_at, items));
        }
        _ => {}
    }
}

impl FreshTopicSource for CtripDiningSource {
    fn id(&self) -> &'static str {
        "ctrip-dining"
    }
    fn name(&self) -> &'static str {
        "携程餐厅榜"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["food"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("food") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match client
            .get("https://you.ctrip.com/restaurant/china110000.html")
            .send()
        {
            Ok(response) if response.status().is_success() => {
                match read_response_bounded_with_limit(response, 4 * 1024 * 1024) {
                    Ok(body) => body,
                    Err(status) => {
                        return FreshTopicSourceResult {
                            status,
                            items: Vec::new(),
                        }
                    }
                }
            }
            Ok(response) => {
                return FreshTopicSourceResult {
                    status: classify_http_status(response.status()).into(),
                    items: Vec::new(),
                }
            }
            Err(error) => {
                return FreshTopicSourceResult {
                    status: classify_request_error(&error).into(),
                    items: Vec::new(),
                }
            }
        };
        let Ok(html) = std::str::from_utf8(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let Some(json) = html_fragment_after(
            html,
            "<script id=\"__NEXT_DATA__\" type=\"application/json\" crossorigin=\"anonymous\">",
            "</script>",
        ) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(json) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let mut items = Vec::new();
        collect_ctrip_dining(&payload, fetched_at, &mut items);
        let items = normalize_topics_unbounded(items);
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

fn collect_ctrip_attractions(
    value: &serde_json::Value,
    fetched_at: &str,
    items: &mut Vec<FreshTopic>,
) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                collect_ctrip_attractions(value, fetched_at, items);
            }
        }
        serde_json::Value::Object(object) => {
            if let (Some(title), Some(raw_url)) = (
                object.get("poiName").and_then(|value| value.as_str()),
                object.get("detailUrl").and_then(|value| value.as_str()),
            ) {
                if let Some(url) = canonicalize_url(raw_url) {
                    let district = object
                        .get("districtName")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let score = object.get("commentScore").and_then(|value| value.as_f64());
                    let tags = object
                        .get("tagNameList")
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|value| value.as_str())
                        .take(4)
                        .collect::<Vec<_>>()
                        .join("、");
                    let summary = format!(
                        "{}{}{}",
                        if district.is_empty() {
                            String::new()
                        } else {
                            format!("位于{district}；")
                        },
                        score
                            .map(|value| format!("评分 {value:.1}；"))
                            .unwrap_or_default(),
                        if tags.is_empty() {
                            "热门景点".into()
                        } else {
                            format!("特色：{tags}")
                        }
                    );
                    if let Some(topic) = normalized_topic(FreshTopic {
                        source_id: format!("ctrip-attraction:{:016x}", fnv1a64(url.as_bytes())),
                        source_name: "携程景点榜".into(),
                        canonical_url: url,
                        title: title.into(),
                        published_at: None,
                        fetched_at: fetched_at.into(),
                        short_text: summary,
                        category: "travel".into(),
                        locale: "zh-CN".into(),
                    }) {
                        items.push(topic);
                    }
                }
            }
            for value in object.values() {
                collect_ctrip_attractions(value, fetched_at, items);
            }
        }
        _ => {}
    }
}

impl FreshTopicSource for CtripAttractionsSource {
    fn id(&self) -> &'static str {
        "ctrip-attractions"
    }
    fn name(&self) -> &'static str {
        "携程景点榜"
    }
    fn categories(&self) -> &'static [&'static str] {
        &["travel"]
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        if !quotas.contains_key("travel") {
            return FreshTopicSourceResult {
                status: "empty".into(),
                items: Vec::new(),
            };
        }
        let body = match client
            .get("https://you.ctrip.com/sight/china110000.html")
            .send()
        {
            Ok(response) if response.status().is_success() => {
                match read_response_bounded_with_limit(response, 4 * 1024 * 1024) {
                    Ok(body) => body,
                    Err(status) => {
                        return FreshTopicSourceResult {
                            status,
                            items: Vec::new(),
                        }
                    }
                }
            }
            Ok(response) => {
                return FreshTopicSourceResult {
                    status: classify_http_status(response.status()).into(),
                    items: Vec::new(),
                }
            }
            Err(error) => {
                return FreshTopicSourceResult {
                    status: classify_request_error(&error).into(),
                    items: Vec::new(),
                }
            }
        };
        let Ok(html) = std::str::from_utf8(&body) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let Some(json) = html_fragment_after(
            html,
            "<script id=\"__NEXT_DATA__\" type=\"application/json\" crossorigin=\"anonymous\">",
            "</script>",
        ) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(json) else {
            return FreshTopicSourceResult {
                status: "parse_error".into(),
                items: Vec::new(),
            };
        };
        let mut items = Vec::new();
        collect_ctrip_attractions(&payload, fetched_at, &mut items);
        let items = normalize_topics_unbounded(items);
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "parse_error"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

impl FreshTopicSource for BingCategorySearchSource {
    fn id(&self) -> &'static str {
        "bing-category-search"
    }
    fn name(&self) -> &'static str {
        "必应分类搜索"
    }
    fn categories(&self) -> &'static [&'static str] {
        VALID_CATEGORIES
    }
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        let queries = [
            ("books", "热门图书 新书 书籍简介 推荐"),
            ("film-tv", "当下热门电影 影片简介 评分"),
            ("music", "新歌 新单曲 新专辑 歌曲介绍"),
            ("food", "热门餐厅 餐馆 探店 招牌菜 必吃 推荐"),
            ("travel", "热门旅游景点 好玩的地方 景点介绍 攻略"),
            ("games", "近期热门游戏 新游戏 玩法介绍"),
            ("technology", "科技数码新品 产品介绍 评测"),
            ("sports", "近期体育赛事 运动项目 介绍"),
            ("work-growth", "招聘 岗位 职位 社招 校招 薪资 福利"),
            ("daily-life", "近期生活方式 健康 消费 实用信息"),
            ("science", "近期科学科普 研究发现 介绍"),
        ];
        let mut items = Vec::new();
        let mut failures = 0usize;
        for (category, query) in queries
            .into_iter()
            .filter(|(category, _)| quotas.contains_key(*category))
        {
            let role_query;
            let query = if category == "work-growth" && !work_role_hints().is_empty() {
                role_query = format!(
                    "{} 招聘 岗位 职位 社招 校招 薪资 福利",
                    work_role_hints().join(" ")
                );
                role_query.as_str()
            } else {
                query
            };
            let body = source_http_result(
                client
                    .get("https://www.bing.com/search")
                    .query(&[("q", query), ("format", "rss"), ("mkt", "zh-CN")])
                    .send(),
            );
            let Ok(body) = body else {
                failures += 1;
                continue;
            };
            let mut parsed =
                parse_rss_items(&body, self.id(), self.name(), Some(category), fetched_at);
            for item in &mut parsed {
                item.category = category.into();
            }
            items.extend(parsed.into_iter().take(20));
        }
        FreshTopicSourceResult {
            status: if items.is_empty() {
                "provider_error"
            } else if failures > 0 {
                "partial"
            } else {
                "ok"
            }
            .into(),
            items,
        }
    }
}

#[allow(dead_code)]
pub struct GdeltSource {
    id: &'static str,
    query: &'static str,
    categories: &'static [&'static str],
}

#[allow(dead_code)]
static GDELT_MAINLAND_LIFESTYLE: GdeltSource = GdeltSource {
    id: "gdelt-mainland-lifestyle",
    query: "(生活 OR 美食 OR 旅行 OR 文旅 OR 消费 OR 健康 OR 影视 OR 展览 OR 体育) sourcecountry:China sourcelang:Chinese",
    categories: &["lifestyle", "culture", "movies"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_MOVIES: GdeltSource = GdeltSource {
    id: "gdelt-mainland-movies",
    query: "(电影 OR 影视 OR 院线 OR 票房) sourcecountry:China sourcelang:Chinese",
    categories: &["movies"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_GAMES: GdeltSource = GdeltSource {
    id: "gdelt-mainland-games",
    query: "(游戏 OR 电竞) sourcecountry:China sourcelang:Chinese",
    categories: &["games"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_TECHNOLOGY: GdeltSource = GdeltSource {
    id: "gdelt-mainland-technology",
    query:
        "(科技 OR 人工智能 OR 芯片 OR 手机 OR 数码 OR 软件) sourcecountry:China sourcelang:Chinese",
    categories: &["technology"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_CULTURE: GdeltSource = GdeltSource {
    id: "gdelt-mainland-culture",
    query: "(文化 OR 艺术 OR 音乐 OR 图书 OR 展览 OR 演出) sourcecountry:China sourcelang:Chinese",
    categories: &["culture", "movies"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_LIFE: GdeltSource = GdeltSource {
    id: "gdelt-mainland-life",
    query: "(生活 OR 美食 OR 旅行 OR 文旅 OR 消费 OR 健康 OR 健身 OR 体育) sourcecountry:China sourcelang:Chinese",
    categories: &["lifestyle"],
};
#[allow(dead_code)]
static GDELT_MAINLAND_SCIENCE: GdeltSource = GdeltSource {
    id: "gdelt-mainland-science",
    query: "(科学 OR 太空 OR 航天 OR 科普) sourcecountry:China sourcelang:Chinese",
    categories: &["science"],
};
#[allow(dead_code)]
static HACKER_NEWS: HackerNewsSource = HackerNewsSource;
static CHINA_NEWS: ChinaNewsSource = ChinaNewsSource;
static BAIDU_HOT: BaiduHotSource = BaiduHotSource;
static BILIBILI_POPULAR: BilibiliPopularSource = BilibiliPopularSource;
static ITHOME: ItHomeSource = ItHomeSource;
static STEAM_POPULAR: SteamPopularSource = SteamPopularSource;
static STEAM_FREE_GAMES: SteamFreeGamesSource = SteamFreeGamesSource;
static STEAM_NEW_RELEASES: SteamNewReleasesSource = SteamNewReleasesSource;
static EPIC_FREE_GAMES: EpicFreeGamesSource = EpicFreeGamesSource;
static APPLE_GAME_CHART: AppleGameChartSource = AppleGameChartSource;
static DOUBAN_MOVIE: DoubanMovieSource = DoubanMovieSource;
static SODA_MUSIC: SodaMusicSource = SodaMusicSource;
static NETEASE_NEW_SONGS: NeteaseNewSongsSource = NeteaseNewSongsSource;
static BING_CATEGORY_SEARCH: BingCategorySearchSource = BingCategorySearchSource;
static CITY_DINING_SEARCH: CityDiningSearchSource = CityDiningSearchSource;
static CTRIP_DINING: CtripDiningSource = CtripDiningSource;
static CTRIP_ATTRACTIONS: CtripAttractionsSource = CtripAttractionsSource;
#[allow(dead_code)]
static GDELT_LAST_REQUEST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

#[allow(dead_code)]
fn reserve_gdelt_request() -> bool {
    let mut last = GDELT_LAST_REQUEST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap();
    let now = Instant::now();
    if last.is_some_and(|previous| now.duration_since(previous) < GDELT_MIN_REQUEST_INTERVAL) {
        return false;
    }
    *last = Some(now);
    true
}

impl FreshTopicSource for GdeltSource {
    fn id(&self) -> &'static str {
        self.id
    }

    fn name(&self) -> &'static str {
        "GDELT"
    }

    fn categories(&self) -> &'static [&'static str] {
        self.categories
    }

    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        _quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult {
        const ENDPOINT: &str = "https://api.gdeltproject.org/api/v2/doc/doc";
        if !reserve_gdelt_request() {
            return FreshTopicSourceResult {
                status: "cooldown".into(),
                items: Vec::new(),
            };
        }
        let response = match client
            .get(ENDPOINT)
            .query(&[
                ("query", self.query),
                ("mode", "artlist"),
                ("format", "json"),
                ("maxrecords", "30"),
                ("sort", "datedesc"),
                ("timespan", "7d"),
            ])
            .send()
        {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                return FreshTopicSourceResult {
                    status: classify_http_status(response.status()).into(),
                    items: Vec::new(),
                }
            }
            Err(error) => {
                return FreshTopicSourceResult {
                    status: classify_request_error(&error).into(),
                    items: Vec::new(),
                }
            }
        };
        let payload: serde_json::Value = match response.json() {
            Ok(payload) => payload,
            Err(_) => {
                return FreshTopicSourceResult {
                    status: "provider_error".into(),
                    items: Vec::new(),
                }
            }
        };
        let items: Vec<_> = parse_gdelt_articles(&payload, fetched_at)
            .into_iter()
            .filter(|item| self.categories.contains(&item.category.as_str()))
            .collect();
        FreshTopicSourceResult {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }
}

fn default_sources() -> Vec<&'static dyn FreshTopicSource> {
    vec![
        &CHINA_NEWS,
        &BAIDU_HOT,
        &BILIBILI_POPULAR,
        &ITHOME,
        &STEAM_FREE_GAMES,
        &STEAM_NEW_RELEASES,
        &EPIC_FREE_GAMES,
        &APPLE_GAME_CHART,
        &DOUBAN_MOVIE,
        &SODA_MUSIC,
        &NETEASE_NEW_SONGS,
        &CITY_DINING_SEARCH,
        &CTRIP_DINING,
        &CTRIP_ATTRACTIONS,
        &BING_CATEGORY_SEARCH,
    ]
}

fn push_source(
    sources: &mut Vec<&'static dyn FreshTopicSource>,
    source: &'static dyn FreshTopicSource,
) {
    if !sources.iter().any(|existing| existing.id() == source.id()) {
        sources.push(source);
    }
}

#[allow(dead_code)]
fn mainland_sources_for_categories(categories: &[&str]) -> Vec<&'static dyn FreshTopicSource> {
    let mut sources = Vec::new();
    for category in categories {
        let source: Option<&'static dyn FreshTopicSource> = match *category {
            "lifestyle" => Some(&GDELT_MAINLAND_LIFE),
            "movies" => Some(&GDELT_MAINLAND_MOVIES),
            "games" => Some(&GDELT_MAINLAND_GAMES),
            "technology" => Some(&GDELT_MAINLAND_TECHNOLOGY),
            "culture" => Some(&GDELT_MAINLAND_CULTURE),
            "science" => Some(&GDELT_MAINLAND_SCIENCE),
            _ => None,
        };
        if let Some(source) = source {
            push_source(&mut sources, source);
        }
    }
    sources
}

fn fallback_sources_for_categories(categories: &[&str]) -> Vec<&'static dyn FreshTopicSource> {
    let mut sources = Vec::new();
    for source in default_sources() {
        if source
            .categories()
            .iter()
            .any(|category| categories.contains(category))
        {
            push_source(&mut sources, source);
        }
    }
    sources
}

#[cfg(test)]
fn default_source_ids() -> Vec<&'static str> {
    default_sources().iter().map(|source| source.id()).collect()
}

#[allow(dead_code)]
fn mainland_source_ids_for_categories(categories: &[&str]) -> Vec<&'static str> {
    mainland_sources_for_categories(categories)
        .iter()
        .map(|source| source.id())
        .collect()
}

#[cfg(test)]
fn fallback_source_ids_for_categories(categories: &[&str]) -> Vec<&'static str> {
    fallback_sources_for_categories(categories)
        .iter()
        .map(|source| source.id())
        .collect()
}

fn classify_request_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "unavailable"
    } else {
        "provider_error"
    }
}

fn classify_http_status(status: reqwest::StatusCode) -> &'static str {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        "rate_limited"
    } else if status.is_server_error() {
        "provider_error"
    } else if status.is_client_error() {
        "auth_or_request_error"
    } else {
        "provider_error"
    }
}

fn build_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; kxyy-desktop-pet/0.2.49; local fresh-topic cache)")
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "无法初始化新鲜话题网络客户端".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopic {
    pub source_id: String,
    pub source_name: String,
    pub canonical_url: String,
    pub title: String,
    pub published_at: Option<String>,
    pub fetched_at: String,
    pub short_text: String,
    pub category: String,
    pub locale: String,
}

#[derive(Debug, Clone, Default)]
pub struct FreshTopicQuery {
    pub query: String,
    pub categories: Vec<String>,
    pub max_items: usize,
    pub excluded_source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicResponse {
    pub status: String,
    pub items: Vec<FreshTopic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicProviderStatus {
    pub provider: String,
    pub status: String,
    pub item_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicSourceStatus {
    pub provider: String,
    pub name: String,
    pub categories: Vec<String>,
    pub status: String,
    pub candidate_count: usize,
    pub item_count: usize,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub latest_published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicCategoryStatus {
    pub category: String,
    pub requested: usize,
    pub collected: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicStatusResponse {
    pub enabled: bool,
    pub item_count: usize,
    pub sources: Vec<FreshTopicSourceStatus>,
    pub categories: Vec<FreshTopicCategoryStatus>,
    pub items: Vec<FreshTopic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreshTopicPrefetchResponse {
    pub status: String,
    pub item_count: usize,
    pub refreshed_at: String,
    pub providers: Vec<FreshTopicProviderStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshTopicSourceResult {
    pub status: String,
    pub items: Vec<FreshTopic>,
}

pub trait FreshTopicSource {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn categories(&self) -> &'static [&'static str];
    fn fetch(
        &self,
        client: &reqwest::blocking::Client,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicSourceResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshTopicCacheFile {
    schema_version: u32,
    items: Vec<FreshTopic>,
    #[serde(default)]
    provider_items: BTreeMap<String, Vec<FreshTopic>>,
    #[serde(default)]
    provider_attempts: BTreeMap<String, String>,
    #[serde(default)]
    provider_results: BTreeMap<String, ProviderCacheStatus>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCacheStatus {
    status: String,
    item_count: usize,
    attempted_at: String,
    #[serde(default)]
    last_success_at: Option<String>,
    #[serde(default)]
    latest_published_at: Option<String>,
}

pub struct FreshTopicService {
    cache_path: PathBuf,
    items: Mutex<Vec<FreshTopic>>,
    provider_items: Mutex<BTreeMap<String, Vec<FreshTopic>>>,
    provider_attempts: Mutex<BTreeMap<String, String>>,
    provider_results: Mutex<BTreeMap<String, ProviderCacheStatus>>,
    prefetch_lock: Mutex<()>,
}

impl FreshTopicService {
    pub fn open(cache_path: PathBuf) -> Self {
        let cache = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<FreshTopicCacheFile>(&raw).ok())
            .filter(|cache| cache.schema_version == CACHE_SCHEMA_VERSION);
        let (items, provider_items, provider_attempts, provider_results) = cache
            .map(|cache| {
                (
                    normalize_topics(cache.items),
                    cache
                        .provider_items
                        .into_iter()
                        .map(|(provider, mut items)| {
                            items = normalize_topics_unbounded(items);
                            items.truncate(PROVIDER_POOL_MAX_ITEMS);
                            (provider, items)
                        })
                        .collect(),
                    cache.provider_attempts,
                    cache.provider_results,
                )
            })
            .unwrap_or_default();
        Self {
            cache_path,
            items: Mutex::new(items),
            provider_items: Mutex::new(provider_items),
            provider_attempts: Mutex::new(provider_attempts),
            provider_results: Mutex::new(provider_results),
            prefetch_lock: Mutex::new(()),
        }
    }

    pub fn replace(&self, items: Vec<FreshTopic>) -> Result<usize, String> {
        let items = normalize_topics(items);
        let cache = FreshTopicCacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            items: items.clone(),
            provider_items: self.provider_items.lock().unwrap().clone(),
            provider_attempts: self.provider_attempts.lock().unwrap().clone(),
            provider_results: self.provider_results.lock().unwrap().clone(),
        };
        if let Some(parent) = self.cache_path.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建新鲜话题缓存目录".to_string())?;
        }
        let temporary = self.cache_path.with_extension("json.tmp");
        let raw = serde_json::to_vec(&cache).map_err(|_| "无法序列化新鲜话题缓存".to_string())?;
        fs::write(&temporary, raw).map_err(|_| "无法写入新鲜话题缓存".to_string())?;
        if fs::rename(&temporary, &self.cache_path).is_err() {
            fs::remove_file(&self.cache_path).map_err(|_| "无法提交新鲜话题缓存".to_string())?;
            fs::rename(&temporary, &self.cache_path)
                .map_err(|_| "无法提交新鲜话题缓存".to_string())?;
        }
        *self.items.lock().unwrap() = items;
        Ok(cache.items.len())
    }

    fn candidate_items(&self) -> Vec<FreshTopic> {
        let mut candidates = self.items.lock().unwrap().clone();
        for items in self.provider_items.lock().unwrap().values() {
            candidates.extend(items.clone());
        }
        candidates
    }

    fn source_refresh_due(&self, source_id: &str, now: &str, force: bool) -> bool {
        let Some(now) = chrono::DateTime::parse_from_rfc3339(now).ok() else {
            return true;
        };
        self.provider_attempts
            .lock()
            .unwrap()
            .get(source_id)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_none_or(|previous| {
                previous > now
                    || if force {
                        now.signed_duration_since(previous).num_seconds()
                            >= MANUAL_REFRESH_COOLDOWN_SECONDS
                    } else {
                        now.signed_duration_since(previous).num_hours() >= PROVIDER_REFRESH_HOURS
                    }
            })
    }

    pub fn query(&self, request: FreshTopicQuery, now: &str) -> FreshTopicResponse {
        let Some(now) = chrono::DateTime::parse_from_rfc3339(now).ok() else {
            return FreshTopicResponse {
                status: "empty".into(),
                items: Vec::new(),
            };
        };
        let categories: Vec<_> = request
            .categories
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect();
        let query = request.query.trim().to_lowercase();
        let excluded_source_ids: std::collections::HashSet<_> = request
            .excluded_source_ids
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect();
        let inferred_categories = if categories.is_empty() {
            query_categories(&query)
        } else {
            Vec::new()
        };
        let generic_request = categories.is_empty() && inferred_categories.is_empty();
        let mut items: Vec<_> = self
            .items
            .lock()
            .unwrap()
            .iter()
            .filter(|item| {
                let fetched_at = chrono::DateTime::parse_from_rfc3339(&item.fetched_at).ok();
                let fresh = fetched_at.is_some_and(|fetched_at| {
                    fetched_at <= now
                        && now.signed_duration_since(fetched_at).num_days() <= TOPIC_MAX_AGE_DAYS
                });
                let category_matches = generic_request
                    || categories
                        .iter()
                        .any(|category| category == &item.category.to_ascii_lowercase())
                    || inferred_categories
                        .iter()
                        .any(|category| *category == item.category);
                let query_matches = generic_request
                    || !categories.is_empty()
                    || !inferred_categories.is_empty()
                    || item.title.to_lowercase().contains(&query)
                    || item.short_text.to_lowercase().contains(&query);
                fresh
                    && category_matches
                    && query_matches
                    && !excluded_source_ids.contains(item.source_id.as_str())
            })
            .cloned()
            .collect();
        items.sort_by(|left, right| {
            let category_order = if generic_request {
                generic_category_rank(&left.category).cmp(&generic_category_rank(&right.category))
            } else {
                std::cmp::Ordering::Equal
            };
            category_order.then_with(|| {
                right
                    .published_at
                    .as_deref()
                    .unwrap_or(&right.fetched_at)
                    .cmp(left.published_at.as_deref().unwrap_or(&left.fetched_at))
            })
        });
        items.truncate(request.max_items.clamp(1, QUERY_MAX_ITEMS));
        FreshTopicResponse {
            status: if items.is_empty() { "empty" } else { "ok" }.into(),
            items,
        }
    }

    pub fn prefetch(
        &self,
        client: &reqwest::blocking::Client,
        sources: &[&dyn FreshTopicSource],
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
        force: bool,
    ) -> FreshTopicPrefetchResponse {
        let _prefetch_guard = self.prefetch_lock.lock().unwrap();
        {
            let mut pools = self.provider_items.lock().unwrap();
            if quotas.is_empty() {
                pools.clear();
            } else {
                for items in pools.values_mut() {
                    *items = provider_pool_items(std::mem::take(items), quotas);
                }
                pools.retain(|_, items| !items.is_empty());
            }
        }
        if sources.is_empty() {
            let selected = apply_category_quotas(self.candidate_items(), quotas);
            let count = self
                .replace(selected)
                .unwrap_or_else(|_| self.items.lock().unwrap().len());
            return FreshTopicPrefetchResponse {
                status: "empty".into(),
                item_count: count,
                refreshed_at: fetched_at.into(),
                providers: Vec::new(),
            };
        }
        let mut provider_statuses = Vec::with_capacity(sources.len());
        let mut successful_sources = 0usize;
        for source in sources {
            if !self.source_refresh_due(source.id(), fetched_at, force) {
                successful_sources += 1;
                provider_statuses.push(FreshTopicProviderStatus {
                    provider: source.id().into(),
                    status: "cached".into(),
                    item_count: 0,
                });
                continue;
            }
            let result = source.fetch(client, fetched_at, quotas);
            let item_count = result.items.len();
            if matches!(result.status.as_str(), "ok" | "partial" | "empty") {
                successful_sources += 1;
                self.items
                    .lock()
                    .unwrap()
                    .retain(|item| item.source_name != source.name());
                let fresh_pool = provider_pool_items(result.items.clone(), quotas);
                let mut pools = self.provider_items.lock().unwrap();
                if result.status == "partial" {
                    let mut merged = pools.remove(source.id()).unwrap_or_default();
                    merged.extend(fresh_pool);
                    pools.insert(source.id().into(), provider_pool_items(merged, quotas));
                } else if fresh_pool.is_empty() {
                    pools.remove(source.id());
                } else {
                    pools.insert(source.id().into(), fresh_pool);
                }
            }
            if result.status != "cooldown" {
                self.provider_attempts
                    .lock()
                    .unwrap()
                    .insert(source.id().into(), fetched_at.into());
                let previous_success = self
                    .provider_results
                    .lock()
                    .unwrap()
                    .get(source.id())
                    .and_then(|status| status.last_success_at.clone());
                let latest_published_at = result
                    .items
                    .iter()
                    .filter_map(|item| item.published_at.as_deref())
                    .max()
                    .map(str::to_string);
                self.provider_results.lock().unwrap().insert(
                    source.id().into(),
                    ProviderCacheStatus {
                        status: result.status.clone(),
                        item_count,
                        attempted_at: fetched_at.into(),
                        last_success_at: if matches!(
                            result.status.as_str(),
                            "ok" | "partial" | "empty"
                        ) {
                            Some(fetched_at.into())
                        } else {
                            previous_success
                        },
                        latest_published_at,
                    },
                );
            }
            provider_statuses.push(FreshTopicProviderStatus {
                provider: source.id().into(),
                status: result.status,
                item_count,
            });
        }

        let current_count = self.items.lock().unwrap().len();
        let (status, item_count) = if successful_sources > 0 {
            match self.replace(apply_category_quotas(self.candidate_items(), quotas)) {
                Ok(count) => {
                    let has_failure = provider_statuses.iter().any(|provider| {
                        !matches!(provider.status.as_str(), "ok" | "empty" | "cached")
                    });
                    (
                        if has_failure {
                            "partial"
                        } else if count == 0 {
                            "empty"
                        } else {
                            "ok"
                        },
                        count,
                    )
                }
                Err(_) => ("cache_error", current_count),
            }
        } else {
            let selected = apply_category_quotas(self.candidate_items(), quotas);
            let item_count = self.replace(selected).unwrap_or(current_count);
            ("provider_error", item_count)
        };
        FreshTopicPrefetchResponse {
            status: status.into(),
            item_count,
            refreshed_at: fetched_at.to_string(),
            providers: provider_statuses,
        }
    }

    pub fn prefetch_default_sources(
        &self,
        fetched_at: &str,
        quotas: &BTreeMap<String, usize>,
        force: bool,
    ) -> FreshTopicPrefetchResponse {
        let client = match build_http_client() {
            Ok(client) => client,
            Err(_) => {
                return FreshTopicPrefetchResponse {
                    status: "provider_error".into(),
                    item_count: self.items.lock().unwrap().len(),
                    refreshed_at: fetched_at.into(),
                    providers: Vec::new(),
                }
            }
        };
        let sources: Vec<_> = default_sources()
            .into_iter()
            .filter(|source| {
                source
                    .categories()
                    .iter()
                    .any(|category| quotas.contains_key(*category))
            })
            .collect();
        self.prefetch(&client, &sources, fetched_at, quotas, force)
    }

    pub fn status(
        &self,
        enabled: bool,
        quotas: &BTreeMap<String, usize>,
    ) -> FreshTopicStatusResponse {
        let items = self.items.lock().unwrap().clone();
        let provider_items = self.provider_items.lock().unwrap().clone();
        let provider_results = self.provider_results.lock().unwrap().clone();
        let sources = default_sources()
            .into_iter()
            .map(|source| {
                let cached = items
                    .iter()
                    .filter(|item| item.source_name == source.name())
                    .count();
                let result = provider_results.get(source.id());
                FreshTopicSourceStatus {
                    provider: source.id().into(),
                    name: source.name().into(),
                    categories: source
                        .categories()
                        .iter()
                        .map(|value| (*value).into())
                        .collect(),
                    status: if !enabled {
                        "disabled".into()
                    } else if !source
                        .categories()
                        .iter()
                        .any(|category| quotas.contains_key(*category))
                    {
                        "not_requested".into()
                    } else {
                        result
                            .map(|status| status.status.clone())
                            .unwrap_or_else(|| "not_checked".into())
                    },
                    candidate_count: provider_items
                        .get(source.id())
                        .map(Vec::len)
                        .or_else(|| result.map(|status| status.item_count))
                        .unwrap_or(0),
                    item_count: cached,
                    last_attempt_at: result.map(|status| status.attempted_at.clone()),
                    last_success_at: result.and_then(|status| status.last_success_at.clone()),
                    latest_published_at: result
                        .and_then(|status| status.latest_published_at.clone()),
                }
            })
            .collect();
        let categories = quotas
            .iter()
            .map(|(category, requested)| FreshTopicCategoryStatus {
                category: category.clone(),
                requested: *requested,
                collected: items
                    .iter()
                    .filter(|item| &item.category == category)
                    .count(),
            })
            .collect();
        FreshTopicStatusResponse {
            enabled,
            item_count: items.len(),
            sources,
            categories,
            items,
        }
    }
}

fn app_collection_plan(
    app: &AppHandle,
    override_preferences: Option<&[super::TopicPreference]>,
) -> (bool, BTreeMap<String, usize>) {
    let (enabled, preferences) = {
        let state = app.state::<super::AppState>();
        let settings = state.settings.lock().unwrap();
        (
            settings.web_grounding_enabled,
            settings.topic_preferences.clone(),
        )
    };
    let values = override_preferences.unwrap_or(&preferences);
    (enabled, preference_quotas(values))
}

pub fn prefetch_for_app(
    app: &AppHandle,
    reason: &str,
    force: bool,
    override_preferences: Option<&[super::TopicPreference]>,
) -> FreshTopicPrefetchResponse {
    let (enabled, quotas) = app_collection_plan(app, override_preferences);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let response = if !enabled {
        FreshTopicPrefetchResponse {
            status: "disabled".into(),
            item_count: 0,
            refreshed_at: now,
            providers: Vec::new(),
        }
    } else {
        app.state::<FreshTopicService>()
            .prefetch_default_sources(&now, &quotas, force)
    };
    let _ = app.emit(
        "fresh-topic-status",
        serde_json::json!({ "reason": reason, "result": response }),
    );
    response
}

pub fn schedule_startup_prefetch(app: AppHandle) {
    // Startup is an explicit freshness boundary: refresh enabled sources once
    // per app launch instead of treating a previous process run as a six-hour
    // cache hit. The normal provider cooldown still prevents duplicate starts
    // within the same launch (and manual refreshes remain rate-limited).
    schedule_prefetch(app, "startup", 8);
}

pub fn schedule_prefetch(app: AppHandle, reason: &'static str, delay_seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(delay_seconds));
        let force = reason == "startup";
        let _ = prefetch_for_app(&app, reason, force, None);
    });
}

pub fn status_for_app(
    app: &AppHandle,
    override_preferences: Option<&[super::TopicPreference]>,
) -> FreshTopicStatusResponse {
    let (enabled, quotas) = app_collection_plan(app, override_preferences);
    app.state::<FreshTopicService>().status(enabled, &quotas)
}

pub fn query_for_app(app: &AppHandle, request: FreshTopicQuery) -> FreshTopicResponse {
    let enabled = {
        let state = app.state::<super::AppState>();
        let settings = state.settings.lock().unwrap();
        settings.web_grounding_enabled
    };
    if !enabled {
        return FreshTopicResponse {
            status: "disabled".into(),
            items: Vec::new(),
        };
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let service = app.state::<FreshTopicService>();
    let cached = service.query(request.clone(), &now);
    if cached.status == "ok" {
        return cached;
    }
    let categories = requested_categories(&request);
    if categories.is_empty() {
        return cached;
    }
    let category_refs: Vec<&str> = categories.iter().map(String::as_str).collect();
    let Ok(client) = build_http_client() else {
        return cached;
    };
    let fallback_sources = fallback_sources_for_categories(&category_refs);
    if !fallback_sources.is_empty() {
        let quotas: BTreeMap<String, usize> = category_refs
            .iter()
            .map(|category| ((*category).into(), 6))
            .collect();
        let _ = service.prefetch(&client, &fallback_sources, &now, &quotas, false);
    }
    service.query(request, &now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static CACHE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn soda_music_track_url_uses_the_share_route() {
        assert_eq!(
            soda_music_track_url("7512402632118503441"),
            "https://music.douyin.com/qishui/share/track?track_id=7512402632118503441"
        );
    }

    #[test]
    fn canonicalize_url_migrates_legacy_soda_music_song_links() {
        assert_eq!(
            canonicalize_url("https://music.douyin.com/song/7512402632118503441"),
            Some("https://music.douyin.com/qishui/share/track?track_id=7512402632118503441".into())
        );
    }

    fn cache_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = CACHE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "kxyy-fresh-topics-{}-{nonce}-{sequence}.json",
            std::process::id()
        ))
    }

    fn topic(id: &str, title: &str, category: &str, published_at: &str) -> FreshTopic {
        FreshTopic {
            source_id: id.into(),
            source_name: "Fixture News".into(),
            canonical_url: format!("https://example.com/{id}"),
            title: title.into(),
            published_at: Some(published_at.into()),
            fetched_at: "2026-08-08T04:00:00Z".into(),
            short_text: format!("{title} 的简短资料"),
            category: category.into(),
            locale: "zh-CN".into(),
        }
    }

    fn topic_from_source(
        id: &str,
        source_name: &str,
        title: &str,
        category: &str,
        published_at: &str,
    ) -> FreshTopic {
        let mut item = topic(id, title, category, published_at);
        item.source_name = source_name.into();
        item
    }

    struct FixtureSource {
        id: &'static str,
        status: &'static str,
        items: Vec<FreshTopic>,
    }

    impl FreshTopicSource for FixtureSource {
        fn id(&self) -> &'static str {
            self.id
        }

        fn name(&self) -> &'static str {
            "Fixture Source"
        }

        fn categories(&self) -> &'static [&'static str] {
            &["film-tv", "technology"]
        }

        fn fetch(
            &self,
            _client: &reqwest::blocking::Client,
            _fetched_at: &str,
            _quotas: &BTreeMap<String, usize>,
        ) -> FreshTopicSourceResult {
            FreshTopicSourceResult {
                status: self.status.into(),
                items: self.items.clone(),
            }
        }
    }

    struct CountingSource<'a> {
        calls: &'a AtomicU64,
    }

    impl FreshTopicSource for CountingSource<'_> {
        fn id(&self) -> &'static str {
            "counting-source"
        }

        fn name(&self) -> &'static str {
            "Counting Source"
        }

        fn categories(&self) -> &'static [&'static str] {
            &["technology"]
        }

        fn fetch(
            &self,
            _client: &reqwest::blocking::Client,
            _fetched_at: &str,
            _quotas: &BTreeMap<String, usize>,
        ) -> FreshTopicSourceResult {
            self.calls.fetch_add(1, Ordering::Relaxed);
            FreshTopicSourceResult {
                status: "rate_limited".into(),
                items: Vec::new(),
            }
        }
    }

    #[test]
    fn rss_parser_sanitizes_bounded_description_and_normalizes_rfc2822_time() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0"><channel><title>频道标题</title><item>
          <title>周末跑步活动开放报名</title>
          <link>https://example.com/sports?id=1&amp;utm_source=rss</link>
          <description><![CDATA[<p>这是一场适合普通跑者参加的周末社区活动，设有轻松组和进阶组。</p>]]></description>
          <pubDate>Sat, 08 Aug 2026 13:40:08 +0800</pubDate>
          </item></channel></rss>"#;
        let items = parse_rss_items(
            xml.as_bytes(),
            "fixture-rss",
            "Fixture RSS",
            Some("daily-life"),
            "2026-08-08T06:00:00Z",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].category, "sports");
        assert_eq!(
            items[0].short_text,
            "这是一场适合普通跑者参加的周末社区活动，设有轻松组和进阶组。"
        );
        assert_eq!(items[0].canonical_url, "https://example.com/sports?id=1");
        assert_eq!(
            items[0].published_at.as_deref(),
            Some("2026-08-08T05:40:08Z")
        );
        assert!(!items[0].short_text.contains('<'));
        assert!(!items[0].short_text.contains('>'));
    }

    #[test]
    fn content_quality_strips_embedded_web_chrome_without_losing_the_real_summary() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0"><channel><item>
          <title>新款折叠屏手机发布</title>
          <link>https://example.com/phone</link>
          <description>&lt;div class=&quot;article&quot;&gt;这款手机采用轻量机身和新一代处理器，主打长续航。&lt;/div&gt;&lt;style&gt;.article{font-size:16px}.lazy{display:none}&lt;/style&gt;&lt;a href=&quot;/more&quot;&gt;阅读全文&lt;/a&gt;</description>
          </item></channel></rss>"#;
        let items = parse_rss_items(
            xml.as_bytes(),
            "fixture-rss",
            "IT之家 RSS",
            Some("technology"),
            "2026-08-09T06:00:00Z",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].short_text,
            "这款手机采用轻量机身和新一代处理器，主打长续航。"
        );
    }

    #[test]
    fn specialist_game_movie_and_food_parsers_keep_introductions_not_page_metadata() {
        assert_eq!(repair_utf8_mojibake("äºŒåå¤šå¹´"), "二十多年");

        let steam = serde_json::json!({
            "730": {"data": {
                "name": "Counter-Strike 2",
                "short_description": "一款强调团队配合与目标对抗的竞技射击游戏。"
            }}
        });
        let steam = steam_topic_from_detail(730, 1, 1_275_982, &steam, "2026-08-09T06:00:00Z")
            .expect("Steam chart item");
        assert!(steam.short_text.contains("热门第 1 名"));
        assert!(steam.short_text.contains("竞技射击游戏"));

        let apple = serde_json::json!({"feed": {"entry": [{
            "im:name": {"label": "王者荣耀"},
            "summary": {"label": "王者荣耀：5v5团队公平竞技游戏\n【游戏介绍】\n这是一款强调团队合作的多人竞技手游。\n【游戏特色】\n更多宣传文字"},
            "id": {"attributes": {"im:id": "989673964"}},
            "link": [{"attributes": {"rel": "alternate", "href": "https://apps.apple.com/cn/app/id989673964"}}]
        }]}});
        let apple = parse_apple_game_chart(&apple, "2026-08-09T06:00:00Z", 10);
        assert_eq!(apple.len(), 1);
        assert_eq!(apple[0].title, "王者荣耀");
        assert!(apple[0].short_text.contains("多人竞技手游"));
        assert!(!apple[0].short_text.contains("更多宣传文字"));
        let new_apple = serde_json::json!({"feed": {"entry": [{
            "im:name": {"label": "新游戏"},
            "id": {"label": "https://apps.apple.com/cn/app/id123", "attributes": {"im:id": "123"}},
            "link": [{"attributes": {"rel": "alternate", "href": "https://apps.apple.com/cn/app/id123"}}],
            "category": {"attributes": {"im:id": "6014", "label": "游戏"}},
            "im:releaseDate": {"attributes": {"label": "2026年08月"}}
        }]}});
        let new_apple = parse_apple_game_chart(&new_apple, "2026-08-09T06:00:00Z", 10);
        assert_eq!(new_apple.len(), 1);
        assert!(new_apple[0].short_text.contains("发布日期"));

        let movie = douban_movie_topic(
            "年会不能停！2",
            "https://movie.douban.com/subject/36850814/",
            Some("6.7"),
            &serde_json::json!({"intro": "两个职场倒霉蛋意外组成搭档，在公司危机中寻找翻盘机会。"}),
            "2026-08-09T06:00:00Z",
        )
        .expect("Douban synopsis");
        assert!(movie.short_text.contains("公司危机"));
        assert!(!movie.short_text.contains("主演"));

        let food = xiachufang_recipe_topic(
            "https://www.xiachufang.com/recipe/107407712/",
            &serde_json::json!({
                "name": "山药排骨汤",
                "description": "汤汁鲜美、暖胃又营养，适合秋冬和家常聚餐。",
                "recipeCategory": "家常菜",
                "aggregateRating": {"ratingValue": "7.7"},
                "recipeIngredient": ["排骨", "山药"],
                "recipeInstructions": "很长的完整步骤不应进入简介"
            }),
            "2026-08-09T06:00:00Z",
        )
        .expect("recipe introduction");
        assert!(food.short_text.contains("汤汁鲜美"));
        assert!(!food.short_text.contains("完整步骤"));
    }

    #[test]
    fn json_source_classification_is_fixed_and_unknown_bilibili_sections_are_dropped() {
        assert_eq!(bilibili_category("美食侦探"), Some("food"));
        assert_eq!(bilibili_category("单机游戏"), Some("games"));
        assert_eq!(bilibili_category("数码"), Some("technology"));
        assert_eq!(bilibili_category("校园学习"), Some("work-growth"));
        assert_eq!(bilibili_category("社科·法律·心理"), Some("work-growth"));
        assert_eq!(bilibili_category("鬼畜调教"), None);

        let payload = serde_json::json!({
            "cards": [{"content": [{"content": [{
                "word": "周末城市跑步活动",
                "desc": "热榜候选",
                "url": "https://m.baidu.com/s?word=running"
            }]}]}]
        });
        let mut items = Vec::new();
        collect_baidu_entries(&payload, None, "2026-08-08T05:00:00Z", &mut items);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].category, "sports");
        assert_eq!(items[0].published_at, None);
    }

    #[test]
    fn category_object_filter_rejects_adjacent_news_and_keeps_subject_cards() {
        let item = |category: &str, source: &str, title: &str, summary: &str| FreshTopic {
            source_id: format!("fixture:{title}"),
            source_name: source.into(),
            canonical_url: "https://example.com/item".into(),
            title: title.into(),
            published_at: None,
            fetched_at: "2026-08-08T05:00:00Z".into(),
            short_text: summary.into(),
            category: category.into(),
            locale: "zh-CN".into(),
        };
        assert!(is_category_object_candidate(&item(
            "books",
            "百度热榜",
            "诡秘之主",
            "蒸汽与机械交织的奇幻小说简介"
        )));
        assert!(is_category_object_candidate(&item(
            "film-tv",
            "百度热榜",
            "功夫女足",
            "周星驰新作，功夫与足球结合的喜剧电影"
        )));
        assert!(!is_category_object_candidate(&item(
            "film-tv",
            "中新网 RSS",
            "2026年度电影总票房突破240亿",
            "2026年度电影总票房突破240亿"
        )));
        assert!(!is_category_object_candidate(&item(
            "travel",
            "百度热榜",
            "景区透露演员待遇",
            "演员担任景区NPC，不存在高薪"
        )));
        assert!(is_category_object_candidate(&item(
            "travel",
            "哔哩哔哩热门",
            "杭州周末旅行攻略",
            "三个值得打卡的西湖周边景点和游玩路线"
        )));
        assert!(!is_category_object_candidate(&item(
            "music",
            "中新网 RSS",
            "中美青年共赴音乐盛宴",
            "校园举办音乐交流活动"
        )));
        assert!(!is_category_object_candidate(&item(
            "work-growth",
            "必应分类搜索",
            "职业规划是什么意思",
            "职业规划是对职业生涯乃至人生进行持续系统计划的过程"
        )));
    }

    #[test]
    fn multi_feed_sources_request_only_categories_present_in_the_plan() {
        let sports = BTreeMap::from([("sports".into(), 3)]);
        assert!(china_news_feed_requested(
            "https://www.chinanews.com.cn/rss/sports.xml",
            &sports
        ));
        assert!(!china_news_feed_requested(
            "https://www.chinanews.com.cn/rss/life.xml",
            &sports
        ));
        assert!(baidu_board_requested("realtime", &sports));
        assert!(!baidu_board_requested("movie", &sports));

        let films = BTreeMap::from([("film-tv".into(), 6)]);
        assert!(china_news_feed_requested(
            "https://www.chinanews.com.cn/rss/culture.xml",
            &films
        ));
        assert!(!china_news_feed_requested(
            "https://www.chinanews.com.cn/rss/society.xml",
            &films
        ));
        assert!(baidu_board_requested("movie", &films));
        assert!(baidu_board_requested("teleplay", &films));
        assert!(!baidu_board_requested("realtime", &films));
        assert!(!baidu_board_requested("novel", &films));
    }

    #[test]
    fn preference_quotas_are_ten_fifteen_or_zero_and_apply_after_deduplication() {
        let preferences = vec![
            super::super::TopicPreference {
                topic: "电影影视".into(),
                status: "interested".into(),
                source: "manual".into(),
                confidence: None,
                evidence: None,
            },
            super::super::TopicPreference {
                topic: "科技数码".into(),
                status: "neutral".into(),
                source: "manual".into(),
                confidence: None,
                evidence: None,
            },
            super::super::TopicPreference {
                topic: "游戏".into(),
                status: "not-interested".into(),
                source: "manual".into(),
                confidence: None,
                evidence: None,
            },
        ];
        let quotas = preference_quotas(&preferences);
        assert_eq!(quotas.get("film-tv"), Some(&15));
        assert_eq!(quotas.get("technology"), Some(&10));
        assert!(!quotas.contains_key("games"));

        let mut candidates = Vec::new();
        for index in 0..18 {
            candidates.push(topic(
                &format!("movie-{index}"),
                &format!("电影 {index}"),
                "film-tv",
                &format!("2026-08-08T04:{index:02}:00Z"),
            ));
            candidates.push(topic(
                &format!("tech-{index}"),
                &format!("科技 {index}"),
                "technology",
                &format!("2026-08-08T03:{index:02}:00Z"),
            ));
            candidates.push(topic(
                &format!("game-{index}"),
                &format!("游戏 {index}"),
                "games",
                &format!("2026-08-08T02:{index:02}:00Z"),
            ));
        }
        let selected = apply_category_quotas(candidates, &quotas);
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.category == "film-tv")
                .count(),
            15
        );
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.category == "technology")
                .count(),
            10
        );
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.category == "games")
                .count(),
            0
        );
    }

    #[test]
    fn category_quotas_run_before_the_global_cache_limit() {
        let mut candidates = Vec::new();
        for index in 0..100 {
            candidates.push(topic(
                &format!("daily-{index}"),
                &format!("日常消息 {index}"),
                "daily-life",
                &format!("2026-08-08T12:{:02}:00Z", index % 60),
            ));
        }
        for index in 0..3 {
            candidates.push(topic(
                &format!("game-{index}"),
                &format!("游戏消息 {index}"),
                "games",
                &format!("2026-08-07T12:{index:02}:00Z"),
            ));
        }

        let quotas = BTreeMap::from([("daily-life".into(), 3), ("games".into(), 3)]);
        let selected = apply_category_quotas(candidates, &quotas);

        assert_eq!(
            selected
                .iter()
                .filter(|item| item.category == "daily-life")
                .count(),
            3
        );
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.category == "games")
                .count(),
            3
        );
    }

    #[test]
    fn category_selection_balances_pc_and_mobile_game_charts_before_fallback_sources() {
        let candidates = vec![
            topic_from_source(
                "steam-1",
                "Steam 热门榜",
                "Steam 游戏一",
                "games",
                "2026-08-08T12:03:00Z",
            ),
            topic_from_source(
                "steam-2",
                "Steam 热门榜",
                "Steam 游戏二",
                "games",
                "2026-08-08T12:02:00Z",
            ),
            topic_from_source(
                "ios-1",
                "App Store 游戏榜",
                "iOS 游戏一",
                "games",
                "2026-08-08T12:01:00Z",
            ),
            topic_from_source(
                "ios-2",
                "App Store 游戏榜",
                "iOS 游戏二",
                "games",
                "2026-08-08T12:00:00Z",
            ),
            topic_from_source(
                "fallback-1",
                "哔哩哔哩热门",
                "稍早的游戏候选",
                "games",
                "2026-08-08T11:00:00Z",
            ),
        ];
        let selected = apply_category_quotas(candidates, &BTreeMap::from([("games".into(), 4)]));

        assert_eq!(selected.len(), 4);
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.source_name == "Steam 热门榜")
                .count(),
            2
        );
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.source_name == "App Store 游戏榜")
                .count(),
            2
        );
        assert_eq!(
            selected
                .iter()
                .filter(|item| item.source_name == "哔哩哔哩热门")
                .count(),
            0
        );
    }

    #[test]
    fn category_selection_mixes_popular_new_and_free_games_when_available() {
        let candidates = vec![
            topic_from_source(
                "popular",
                "Steam 热门榜",
                "热门游戏",
                "games",
                "2026-08-09T12:03:00Z",
            ),
            topic_from_source(
                "mobile",
                "App Store 游戏榜",
                "手机热门游戏",
                "games",
                "2026-08-09T12:02:00Z",
            ),
            topic_from_source(
                "new",
                "Steam 新游",
                "刚上架的新游戏",
                "games",
                "2026-08-09T12:01:00Z",
            ),
            topic_from_source(
                "free",
                "Epic 限免",
                "本周免费游戏",
                "games",
                "2026-08-09T12:00:00Z",
            ),
        ];
        let selected = apply_category_quotas(candidates, &BTreeMap::from([("games".into(), 3)]));
        assert_eq!(selected.len(), 3);
        assert!(selected.iter().any(|item| item.source_name == "Steam 新游"));
        assert!(selected.iter().any(|item| item.source_name == "Epic 限免"));
        assert!(selected.iter().any(|item| matches!(
            item.source_name.as_str(),
            "Steam 热门榜" | "App Store 游戏榜"
        )));
    }

    #[test]
    fn category_selection_limits_one_daily_event_family_before_filling_the_quota() {
        let mut candidates = Vec::new();
        for index in 0..6 {
            candidates.push(topic_from_source(
                &format!("typhoon-{index}"),
                "中新网 RSS",
                &format!("台风海棠第 {index} 条最新消息"),
                "daily-life",
                &format!("2026-08-09T12:{index:02}:00Z"),
            ));
        }
        candidates.push(topic_from_source(
            "community-market",
            "中新网 RSS",
            "周末社区市集开放夜间场",
            "daily-life",
            "2026-08-09T11:00:00Z",
        ));
        candidates.push(topic_from_source(
            "museum",
            "百度热榜",
            "城市博物馆推出暑期夜游",
            "daily-life",
            "2026-08-09T10:00:00Z",
        ));

        let selected =
            apply_category_quotas(candidates, &BTreeMap::from([("daily-life".into(), 6)]));
        assert!(
            selected
                .iter()
                .filter(|item| item.title.contains("台风"))
                .count()
                <= 2
        );
        assert!(selected
            .iter()
            .any(|item| item.source_id == "community-market"));
        assert!(selected.iter().any(|item| item.source_id == "museum"));
    }

    #[test]
    fn location_hints_are_normalized_deduplicated_and_bounded() {
        assert_eq!(
            set_location_hints(vec![
                " 杭州市 ".into(),
                "杭州".into(),
                "三亚市".into(),
                "辽阳".into(),
                "第四个城市".into(),
            ]),
            vec!["杭州", "三亚", "辽阳"]
        );
        assert_eq!(set_location_hints(Vec::new()), Vec::<String>::new());
    }

    #[test]
    fn food_selection_accepts_places_and_rejects_recipes() {
        let restaurant = topic_from_source(
            "restaurant",
            "城市餐饮搜索",
            "三亚本地人常去的海鲜餐馆",
            "food",
            "2026-08-09T12:00:00Z",
        );
        let mut recipe = topic_from_source(
            "recipe",
            "必应分类搜索",
            "家常红烧茄子菜谱",
            "food",
            "2026-08-09T12:00:00Z",
        );
        recipe.short_text = "配料、调料和详细做法步骤".into();
        assert!(is_category_object_candidate(&restaurant));
        assert!(!is_category_object_candidate(&recipe));
    }

    #[test]
    fn ctrip_dining_parser_emits_place_metadata_and_detail_links() {
        let payload = serde_json::json!({
            "restList": [{
                "poiId": 123,
                "name": "三亚海鲜餐厅",
                "address": "三亚湾路 1 号",
                "commentScore": 4.8,
                "averagePrice": 128.0
            }]
        });
        let mut items = Vec::new();
        collect_ctrip_dining(&payload, "2026-08-09T12:00:00Z", &mut items);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "三亚海鲜餐厅");
        assert!(items[0].short_text.contains("评分 4.8"));
        assert!(items[0]
            .canonical_url
            .contains("restdetail/china110000/123"));
    }

    #[test]
    fn schema_three_cache_is_invalidated_before_the_new_selection_policy_runs() {
        let path = cache_path();
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 3,
                "items": [topic("old", "旧缓存", "games", "2026-08-08T04:00:00Z")],
                "providerAttempts": {"gcores-rss": "2026-08-08T04:00:00Z"},
                "providerResults": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let service = FreshTopicService::open(path.clone());
        assert!(service.items.lock().unwrap().is_empty());
        assert!(service.provider_attempts.lock().unwrap().is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unselected_provider_candidates_survive_restart_and_larger_quota() {
        let path = cache_path();
        let game = FixtureSource {
            id: "game-source",
            status: "ok",
            items: vec![topic_from_source(
                "game",
                "Game Source",
                "《候选游戏》玩法介绍",
                "games",
                "2026-08-08T04:00:00Z",
            )],
        };
        let fallback_game = FixtureSource {
            id: "fallback-game-source",
            status: "ok",
            items: vec![topic_from_source(
                "fallback-game",
                "Fallback Game Source",
                "《备用游戏》玩法介绍",
                "games",
                "2026-08-08T03:00:00Z",
            )],
        };
        let client = reqwest::blocking::Client::new();
        let service = FreshTopicService::open(path.clone());
        let first = service.prefetch(
            &client,
            &[&game, &fallback_game],
            "2026-08-08T05:00:00Z",
            &BTreeMap::from([("games".into(), 1)]),
            false,
        );
        assert_eq!(first.item_count, 1);

        let reopened = FreshTopicService::open(path.clone());
        let second = reopened.prefetch(
            &client,
            &[&game, &fallback_game],
            "2026-08-08T06:00:00Z",
            &BTreeMap::from([("games".into(), 2)]),
            false,
        );
        assert_eq!(second.item_count, 2);
        assert!(reopened
            .items
            .lock()
            .unwrap()
            .iter()
            .any(|item| item.source_id == "fallback-game"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn successful_empty_refresh_removes_that_sources_old_selection_and_pool() {
        let path = cache_path();
        let populated = FixtureSource {
            id: "fixture",
            status: "ok",
            items: vec![topic_from_source(
                "old",
                "Fixture Source",
                "旧候选",
                "technology",
                "2026-08-08T04:00:00Z",
            )],
        };
        let empty = FixtureSource {
            id: "fixture",
            status: "empty",
            items: Vec::new(),
        };
        let client = reqwest::blocking::Client::new();
        let quotas = BTreeMap::from([("technology".into(), 3)]);
        let service = FreshTopicService::open(path.clone());
        assert_eq!(
            service
                .prefetch(
                    &client,
                    &[&populated],
                    "2026-08-08T05:00:00Z",
                    &quotas,
                    true,
                )
                .item_count,
            1
        );
        assert_eq!(
            service
                .prefetch(&client, &[&empty], "2026-08-08T05:01:00Z", &quotas, true,)
                .item_count,
            0
        );
        assert!(service
            .provider_items
            .lock()
            .unwrap()
            .get("fixture")
            .is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn source_status_lists_default_sources_and_category_shortfalls() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        service
            .replace(vec![topic(
                "tech",
                "科技消息",
                "technology",
                "2026-08-08T04:00:00Z",
            )])
            .unwrap();
        service.provider_results.lock().unwrap().insert(
            "ithome-rss".into(),
            ProviderCacheStatus {
                status: "ok".into(),
                item_count: 60,
                attempted_at: "2026-08-08T05:00:00Z".into(),
                last_success_at: Some("2026-08-08T05:00:00Z".into()),
                latest_published_at: Some("2026-08-08T04:59:00Z".into()),
            },
        );
        let quotas = BTreeMap::from([("technology".into(), 3), ("games".into(), 6)]);
        let status = service.status(true, &quotas);
        assert_eq!(status.sources.len(), default_source_ids().len());
        assert_eq!(status.categories.len(), 2);
        assert_eq!(
            status
                .categories
                .iter()
                .find(|category| category.category == "technology")
                .map(|category| (category.collected, category.requested)),
            Some((1, 3))
        );
        assert!(status.sources.iter().any(|source| {
            source.provider == "china-news-rss" && source.status == "not_requested"
        }));
        assert_eq!(
            status
                .sources
                .iter()
                .find(|source| source.provider == "ithome-rss")
                .map(|source| (source.candidate_count, source.item_count)),
            Some((60, 0))
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_preference_plan_performs_no_source_request_and_clears_cache() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        service
            .replace(vec![topic(
                "old",
                "旧科技消息",
                "technology",
                "2026-08-08T04:00:00Z",
            )])
            .unwrap();
        let response = service.prefetch(
            &reqwest::blocking::Client::new(),
            &[],
            "2026-08-08T05:00:00Z",
            &BTreeMap::new(),
            true,
        );
        assert_eq!(response.status, "empty");
        assert_eq!(response.item_count, 0);
        assert!(response.providers.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cached_topics_survive_restart_and_query_through_the_service_interface() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        let stored = service
            .replace(vec![
                topic("movie", "本周新电影上映", "film-tv", "2026-08-07T12:00:00Z"),
                topic("game", "新游戏公布试玩版", "games", "2026-08-08T01:00:00Z"),
            ])
            .unwrap();
        assert_eq!(stored, 2);

        let reopened = FreshTopicService::open(path.clone());
        let response = reopened.query(
            FreshTopicQuery {
                query: "最近有什么电影".into(),
                categories: vec!["film-tv".into()],
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(response.status, "ok");
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].source_id, "movie");
        assert_eq!(
            response.items[0].published_at.as_deref(),
            Some("2026-08-07T12:00:00Z")
        );
        assert_eq!(response.items[0].fetched_at, "2026-08-08T04:00:00Z");

        let excluded = reopened.query(
            FreshTopicQuery {
                query: "最近有什么电影".into(),
                categories: vec!["film-tv".into()],
                max_items: 3,
                excluded_source_ids: vec!["movie".into()],
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(excluded.status, "empty");
        assert!(excluded.items.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn cache_normalizes_urls_deduplicates_and_expires_old_topics() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        let mut primary = topic("first", "本周新电影上映", "film-tv", "2026-08-07T12:00:00Z");
        primary.canonical_url = "https://example.com/movie?utm_source=test&id=7#details".into();
        let mut duplicate = topic(
            "duplicate",
            "本周新电影上映！",
            "film-tv",
            "2026-08-07T12:30:00Z",
        );
        duplicate.canonical_url = "https://example.com/movie?id=7&utm_medium=chat".into();
        let mut expired = topic(
            "expired",
            "上个月的旧电影",
            "film-tv",
            "2026-07-20T12:00:00Z",
        );
        expired.fetched_at = "2026-07-20T13:00:00Z".into();

        assert_eq!(
            service.replace(vec![primary, duplicate, expired]).unwrap(),
            2
        );
        let response = service.query(
            FreshTopicQuery {
                query: "电影".into(),
                categories: vec!["film-tv".into()],
                max_items: 9,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(response.status, "ok");
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].source_id, "duplicate");
        assert_eq!(
            response.items[0].canonical_url,
            "https://example.com/movie?id=7"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn cache_deduplicates_the_same_event_across_sources_with_title_variants() {
        let newer = topic_from_source(
            "ithome:breath-edge",
            "IT之家 RSS",
            "Steam 喜加一：原价 92 元的外太空生存冒险游戏《呼吸边缘》免费领",
            "games",
            "2026-08-08T13:16:00Z",
        );
        let older = topic_from_source(
            "gcores:breath-edge",
            "机核 RSS",
            "Steam喜加一：《呼吸边缘》免费领",
            "games",
            "2026-08-08T05:40:00Z",
        );

        let normalized = normalize_topics(vec![older, newer]);

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].source_id, "ithome:breath-edge");
    }

    #[test]
    fn restart_normalizes_semantic_duplicates_already_present_in_cache() {
        let path = cache_path();
        let cache = FreshTopicCacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            items: vec![
                topic_from_source(
                    "gcores:breath-edge",
                    "机核 RSS",
                    "Steam喜加一：《呼吸边缘》免费领",
                    "games",
                    "2026-08-08T05:40:00Z",
                ),
                topic_from_source(
                    "ithome:breath-edge",
                    "IT之家 RSS",
                    "Steam 喜加一：原价 92 元的外太空生存冒险游戏《呼吸边缘》免费领",
                    "games",
                    "2026-08-08T13:16:00Z",
                ),
            ],
            provider_items: BTreeMap::new(),
            provider_attempts: BTreeMap::new(),
            provider_results: BTreeMap::new(),
        };
        fs::write(&path, serde_json::to_vec(&cache).unwrap()).unwrap();

        let reopened = FreshTopicService::open(path.clone());
        let response = reopened.query(
            FreshTopicQuery {
                query: "最近有什么游戏".into(),
                categories: vec!["games".into()],
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T14:00:00Z",
        );

        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].source_id, "ithome:breath-edge");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn hacker_news_adapter_maps_official_story_json_to_the_shared_observation() {
        let item = serde_json::json!({
            "id": 49218179,
            "type": "story",
            "time": 1786153751,
            "score": 118,
            "title": "NASA keeps Voyager 2 running for another year",
            "url": "https://www.space.com/voyager?utm_source=hn"
        });
        let topic = parse_hacker_news_story(&item, "2026-08-08T05:00:00Z").unwrap();
        assert_eq!(topic.source_id, "hacker-news:49218179");
        assert_eq!(topic.source_name, "Hacker News");
        assert_eq!(topic.category, "technology");
        assert_eq!(topic.locale, "en-US");
        assert_eq!(topic.canonical_url, "https://www.space.com/voyager");
        assert_eq!(topic.published_at.as_deref(), Some("2026-08-08T01:49:11Z"));
        assert_eq!(topic.fetched_at, "2026-08-08T05:00:00Z");
        assert_eq!(
            topic.short_text,
            "NASA keeps Voyager 2 running for another year"
        );
    }

    #[test]
    fn gdelt_adapter_keeps_seen_time_separate_from_fetch_time_and_classifies_topics() {
        let payload = serde_json::json!({
            "articles": [{
                "url": "https://news.example.cn/culture/movie?id=9&utm_campaign=feed",
                "title": "暑期档新电影公布上映日期",
                "seendate": "20260808T043000Z",
                "domain": "news.example.cn",
                "language": "Chinese",
                "sourcecountry": "China"
            }, {
                "url": "https://example.com/not-mainland",
                "title": "中文科技消息",
                "seendate": "20260808T043100Z",
                "domain": "example.com",
                "language": "Chinese",
                "sourcecountry": "United States"
            }]
        });
        let items = parse_gdelt_articles(&payload, "2026-08-08T05:00:00Z");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_name, "news.example.cn");
        assert_eq!(items[0].category, "film-tv");
        assert_eq!(items[0].locale, "zh-CN");
        assert_eq!(
            items[0].published_at.as_deref(),
            Some("2026-08-08T04:30:00Z")
        );
        assert_eq!(items[0].fetched_at, "2026-08-08T05:00:00Z");
        assert_eq!(
            items[0].canonical_url,
            "https://news.example.cn/culture/movie?id=9"
        );
    }

    #[test]
    fn startup_sources_include_specialists_and_bounded_search_fallback() {
        assert_eq!(
            default_source_ids(),
            vec![
                "china-news-rss",
                "baidu-hot",
                "bilibili-popular",
                "ithome-rss",
                "steam-free-games",
                "steam-new-releases",
                "epic-free-games",
                "app-store-new-games",
                "douban-movie",
                "soda-music-hot",
                "netease-new-songs",
                "city-dining-search",
                "ctrip-dining",
                "ctrip-attractions",
                "bing-category-search",
            ]
        );
        assert!(!default_source_ids().contains(&"hacker-news"));
        assert!(!default_source_ids().contains(&"gdelt-mainland-lifestyle"));
    }

    #[test]
    #[ignore = "requires live network access"]
    fn live_default_sources_return_parseable_bounded_candidates() {
        let client = build_http_client().unwrap();
        let quotas = preference_quotas(&[]);
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        let sources = default_sources();
        let response = service.prefetch(&client, &sources, "2026-08-08T14:00:00Z", &quotas, true);
        assert!(
            matches!(response.status.as_str(), "ok" | "partial"),
            "{:?}",
            response.providers
        );
        assert_eq!(response.providers.len(), default_source_ids().len());
        assert!(response
            .providers
            .iter()
            .any(|provider| provider.status == "ok"));

        let status = service.status(true, &quotas);
        assert!(!status.items.is_empty());
        assert!(status.items.iter().all(is_category_object_candidate));
        assert!(status
            .items
            .iter()
            .all(|item| item.short_text.chars().count() <= 240));
        assert!(status.categories.iter().all(|category| category.collected == category.requested),
            "every requested category must be filled by a specialist or same-category fallback: {:?}; providers: {:?}",
            status.categories, response.providers);
        for provider in ["steam-popular", "app-store-games", "douban-movie"] {
            assert!(
                status
                    .sources
                    .iter()
                    .any(|source| { source.provider == provider && source.candidate_count > 0 }),
                "specialist source must return usable candidates: {provider}"
            );
        }

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], CACHE_SCHEMA_VERSION);
        assert!(persisted["providerItems"]
            .as_object()
            .is_some_and(|items| !items.is_empty()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn explicit_categories_route_only_to_matching_default_sources() {
        assert_eq!(
            fallback_source_ids_for_categories(&["technology"]),
            vec!["bilibili-popular", "ithome-rss", "bing-category-search"],
        );
        assert_eq!(
            fallback_source_ids_for_categories(&["film-tv"]),
            vec![
                "china-news-rss",
                "baidu-hot",
                "bilibili-popular",
                "douban-movie",
                "bing-category-search"
            ],
        );
        assert_eq!(
            fallback_source_ids_for_categories(&["daily-life"]),
            vec![
                "china-news-rss",
                "baidu-hot",
                "bilibili-popular",
                "bing-category-search"
            ],
        );
        assert_eq!(
            fallback_source_ids_for_categories(&["work-growth"]),
            vec!["bilibili-popular", "bing-category-search"],
        );
    }

    #[test]
    fn generic_cache_query_is_lifestyle_first_and_excludes_unrequested_categories() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        service
            .replace(vec![
                topic(
                    "tech",
                    "更新的科技消息",
                    "technology",
                    "2026-08-08T04:59:00Z",
                ),
                topic("life", "生活方式消息", "daily-life", "2026-08-08T04:00:00Z"),
                topic("culture", "音乐活动消息", "music", "2026-08-08T04:30:00Z"),
                topic("general", "本地综合消息", "general", "2026-08-08T03:30:00Z"),
            ])
            .unwrap();
        let response = service.query(
            FreshTopicQuery {
                query: String::new(),
                categories: Vec::new(),
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(
            response
                .items
                .iter()
                .map(|item| item.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["life", "culture", "general"],
        );
        let generic_news = service.query(
            FreshTopicQuery {
                query: "最近有什么新闻".into(),
                categories: Vec::new(),
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(
            generic_news
                .items
                .iter()
                .map(|item| item.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["life", "culture", "general"],
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn prefetch_reports_partial_failure_and_keeps_fresh_cached_topics() {
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        service
            .replace(vec![topic(
                "movie",
                "缓存里的电影话题",
                "film-tv",
                "2026-08-07T12:00:00Z",
            )])
            .unwrap();
        let hn = FixtureSource {
            id: "hacker-news",
            status: "ok",
            items: vec![topic(
                "tech",
                "新技术话题",
                "technology",
                "2026-08-08T03:00:00Z",
            )],
        };
        let gdelt = FixtureSource {
            id: "gdelt",
            status: "rate_limited",
            items: Vec::new(),
        };

        let client = reqwest::blocking::Client::new();
        let quotas = BTreeMap::from([("film-tv".into(), 3), ("technology".into(), 3)]);
        let response = service.prefetch(
            &client,
            &[&hn, &gdelt],
            "2026-08-08T05:00:00Z",
            &quotas,
            false,
        );
        assert_eq!(response.status, "partial");
        assert_eq!(response.item_count, 2);
        assert_eq!(
            response.providers,
            vec![
                FreshTopicProviderStatus {
                    provider: "hacker-news".into(),
                    status: "ok".into(),
                    item_count: 1,
                },
                FreshTopicProviderStatus {
                    provider: "gdelt".into(),
                    status: "rate_limited".into(),
                    item_count: 0,
                },
            ],
        );
        let cached = service.query(
            FreshTopicQuery {
                query: String::new(),
                categories: Vec::new(),
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:01:00Z",
        );
        assert_eq!(cached.items.len(), 2);
        assert!(cached.items.iter().any(|item| item.source_id == "movie"));
        let explicit_technology = service.query(
            FreshTopicQuery {
                query: "聊聊科技".into(),
                categories: vec!["technology".into()],
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:01:00Z",
        );
        assert_eq!(explicit_technology.items.len(), 1);
        assert_eq!(explicit_technology.items[0].source_id, "tech");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn provider_failures_are_cached_for_six_hours_across_restart() {
        let path = cache_path();
        let calls = AtomicU64::new(0);
        let source = CountingSource { calls: &calls };
        let client = reqwest::blocking::Client::new();
        let service = FreshTopicService::open(path.clone());
        let quotas = BTreeMap::from([("technology".into(), 3)]);
        let first = service.prefetch(&client, &[&source], "2026-08-08T05:00:00Z", &quotas, false);
        assert_eq!(first.providers[0].status, "rate_limited");
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        let reopened = FreshTopicService::open(path.clone());
        let second = reopened.prefetch(&client, &[&source], "2026-08-08T10:59:59Z", &quotas, false);
        assert_eq!(second.providers[0].status, "cached");
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        let third = reopened.prefetch(&client, &[&source], "2026-08-08T11:00:00Z", &quotas, false);
        assert_eq!(third.providers[0].status, "rate_limited");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn forced_refresh_still_obeys_thirty_second_provider_cooldown() {
        let path = cache_path();
        let calls = AtomicU64::new(0);
        let source = CountingSource { calls: &calls };
        let client = reqwest::blocking::Client::new();
        let quotas = BTreeMap::from([("technology".into(), 3)]);
        let service = FreshTopicService::open(path.clone());
        let _ = service.prefetch(&client, &[&source], "2026-08-08T05:00:00Z", &quotas, true);
        let early = service.prefetch(&client, &[&source], "2026-08-08T05:00:29Z", &quotas, true);
        assert_eq!(early.providers[0].status, "cached");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let due = service.prefetch(&client, &[&source], "2026-08-08T05:00:30Z", &quotas, true);
        assert_eq!(due.providers[0].status, "rate_limited");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn chinese_category_intents_match_cached_topics_without_exact_title_match() {
        assert_eq!(query_categories("推荐几首新歌"), vec!["music"]);
        assert_eq!(query_categories("有没有适合玩的手游"), vec!["games"]);
        assert_eq!(query_categories("推荐两部新片"), vec!["film-tv"]);
        assert_eq!(query_categories("周末去哪儿玩"), vec!["travel"]);
        assert_eq!(query_categories("附近哪里有好吃的"), vec!["food"]);
        let path = cache_path();
        let service = FreshTopicService::open(path.clone());
        service
            .replace(vec![topic(
                "movie-1",
                "A newly released film",
                "film-tv",
                "2026-08-08T04:00:00Z",
            )])
            .unwrap();
        let response = service.query(
            FreshTopicQuery {
                query: "最近有什么好看的电影".into(),
                categories: Vec::new(),
                max_items: 3,
                excluded_source_ids: Vec::new(),
            },
            "2026-08-08T05:00:00Z",
        );
        assert_eq!(response.status, "ok");
        assert_eq!(response.items.len(), 1);
        let _ = fs::remove_file(path);
    }
}
