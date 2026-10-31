//! App-owned CoreAudio routes; never change the system defaults or use physical audio.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) const INPUT_NAME: &str = "KXYY QQ TX";
pub(crate) const OUTPUT_NAME: &str = "KXYY QQ RX";
const PREFIX: &str = "com.aaronfang.kxyydesktoppet.qq-audio.v1.";
const ERROR: &str = "phone-audio-route-unavailable";
const VIRTUAL: u32 = u32::from_be_bytes(*b"virt");
const AGGREGATE: u32 = u32::from_be_bytes(*b"grup");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Routes {
    pub input_id: u32,
    pub output_id: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Device {
    id: u32,
    name: String,
    uid: String,
    transport: u32,
    inputs: u32,
    outputs: u32,
    sources: Vec<String>,
}
trait Backend: Send + Sync {
    fn devices(&self) -> Result<Vec<Device>, &'static str>;
    fn defaults(&self) -> Result<[u32; 3], &'static str>;
    fn owner_alive(&self, pid: u32) -> bool;
    fn create(&self, name: &str, uid: &str, source: &Device) -> Result<u32, &'static str>;
    fn destroy(&self, id: u32) -> Result<(), &'static str>;
}
fn same_owner(a: &Device, b: &Device) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.uid == b.uid
        && a.transport == AGGREGATE
        && b.transport == AGGREGATE
        && a.sources == b.sources
}
fn owner_pid(device: &Device, role: &str) -> Option<u32> {
    let mut parts = device.uid.strip_prefix(PREFIX)?.split('.');
    if parts.next()? != role {
        return None;
    }
    let pid = parts
        .next()?
        .parse::<u32>()
        .ok()
        .filter(|p| *p > 0 && *p <= i32::MAX as u32)?;
    let text = parts.next()?;
    let id = uuid::Uuid::parse_str(text).ok()?;
    if id.get_version_num() != 4 || id.to_string() != text || parts.next().is_some() {
        return None;
    }
    Some(pid)
}
fn snapshot_ready(backend: &dyn Backend) -> Result<Vec<Device>, &'static str> {
    let end = Instant::now() + Duration::from_millis(750);
    loop {
        if let Ok(devices) = backend.devices() {
            return Ok(devices);
        }
        if Instant::now() >= end {
            return Err(ERROR);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn wait_removed(backend: &dyn Backend, owned: &[Device]) -> Result<(), &'static str> {
    let end = Instant::now() + Duration::from_millis(750);
    loop {
        if backend.devices().is_ok_and(|devices| {
            !owned
                .iter()
                .any(|old| devices.iter().any(|d| same_owner(old, d)))
        }) {
            return Ok(());
        }
        if Instant::now() >= end {
            return Err(ERROR);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
pub(crate) struct Lease {
    backend: Arc<dyn Backend>,
    owned: Vec<Device>,
    routes: Routes,
}
impl Lease {
    pub(crate) fn acquire() -> Result<Self, &'static str> {
        #[cfg(target_os = "macos")]
        {
            Self::acquire_with(Arc::new(native::CoreAudio))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(ERROR)
        }
    }
    #[cfg(test)]
    fn routes(&self) -> &Routes {
        &self.routes
    }
    fn acquire_with(backend: Arc<dyn Backend>) -> Result<Self, &'static str> {
        let defaults = backend.defaults()?;
        let devices = snapshot_ready(&*backend)?;
        let mut sources = Vec::new();
        for (name, channels) in [("BlackHole 2ch", 2), ("BlackHole 16ch", 16)] {
            let matches: Vec<_> = devices.iter().filter(|d| d.name == name).collect();
            let source = matches
                .first()
                .filter(|_| matches.len() == 1)
                .ok_or(ERROR)?;
            if source.id == 0
                || source.transport != VIRTUAL
                || source.inputs != channels
                || source.outputs != channels
                || source.uid.is_empty()
                || source.uid.len() > 1024
            {
                return Err(ERROR);
            }
            sources.push((*source).clone());
        }
        if sources[0].id == sources[1].id || sources[0].uid == sources[1].uid {
            return Err(ERROR);
        }
        let mut stale = Vec::new();
        for (index, (name, role)) in [(INPUT_NAME, "tx"), (OUTPUT_NAME, "rx")]
            .into_iter()
            .enumerate()
        {
            let matches: Vec<_> = devices.iter().filter(|d| d.name == name).collect();
            if matches.len() > 1 {
                return Err(ERROR);
            }
            if let Some(d) = matches.first() {
                let pid = owner_pid(d, role).ok_or(ERROR)?;
                if d.transport != AGGREGATE
                    || d.sources != [sources[index].uid.clone()]
                    || backend.owner_alive(pid)
                {
                    return Err(ERROR);
                }
                stale.push((*d).clone());
            }
        }
        // Validate the complete stale set before deleting anything; never reclaim
        // another live app's route or an aggregate with a physical sub-device.
        for d in &stale {
            backend.destroy(d.id)?;
        }
        wait_removed(&*backend, &stale)?;
        let mut lease = Self {
            backend,
            owned: Vec::new(),
            routes: Routes {
                input_id: 0,
                output_id: 0,
            },
        };
        for (index, name) in [INPUT_NAME, OUTPUT_NAME].into_iter().enumerate() {
            let uid = format!(
                "{PREFIX}{}.{}.{}",
                if index == 0 { "tx" } else { "rx" },
                std::process::id(),
                uuid::Uuid::new_v4()
            );
            let source = &sources[index];
            let id = lease.backend.create(name, &uid, source)?;
            let expected = Device {
                id,
                name: name.into(),
                uid,
                transport: AGGREGATE,
                inputs: source.inputs,
                outputs: source.outputs,
                sources: vec![source.uid.clone()],
            };
            lease.owned.push(expected.clone());
            let end = Instant::now() + Duration::from_millis(750);
            loop {
                if lease
                    .backend
                    .devices()
                    .is_ok_and(|ds| ds.contains(&expected))
                {
                    break;
                }
                if Instant::now() >= end {
                    return Err(ERROR);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let current = snapshot_ready(&*lease.backend)?;
        if lease.backend.defaults()? != defaults
            || [INPUT_NAME, OUTPUT_NAME]
                .iter()
                .any(|name| current.iter().filter(|d| d.name == *name).count() != 1)
            || !sources.iter().all(|s| current.contains(s))
        {
            return Err(ERROR);
        }
        lease.routes = Routes {
            input_id: lease.owned[0].id,
            output_id: lease.owned[1].id,
        };
        if lease.routes.input_id == 0 || lease.routes.input_id == lease.routes.output_id {
            return Err(ERROR);
        }
        Ok(lease)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut removed = Vec::new();
        for expected in self.owned.iter().rev() {
            // A user-reconfigured or replaced device is no longer ours to destroy.
            if snapshot_ready(&*self.backend)
                .is_ok_and(|devices| devices.iter().any(|d| same_owner(expected, d)))
            {
                if self.backend.destroy(expected.id).is_ok() {
                    removed.push(expected.clone());
                }
            }
        }
        // Destruction is asynchronous in CoreAudio. Bound the wait so an
        // immediate off/on does not mistake our retiring route for a live owner.
        let _ = wait_removed(&*self.backend, &removed);
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use core_foundation::{
        array::CFArray,
        base::{CFType, TCFType},
        dictionary::{CFDictionary, CFDictionaryRef},
        number::CFNumber,
        string::CFString,
    };
    use std::{
        ffi::c_void,
        mem::{align_of, size_of},
        ptr,
    };
    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    impl Address {
        fn new(selector: &[u8; 4], scope: u32) -> Self {
            Self {
                selector: u32::from_be_bytes(*selector),
                scope,
                element: 0,
            }
        }
    }
    #[repr(C)]
    struct Buffer {
        channels: u32,
        bytes: u32,
        data: *mut c_void,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            id: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            id: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
        fn AudioHardwareCreateAggregateDevice(spec: CFDictionaryRef, id: *mut u32) -> i32;
        fn AudioHardwareDestroyAggregateDevice(id: u32) -> i32;
    }
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    fn scalar(id: u32, key: &[u8; 4]) -> Result<u32, &'static str> {
        let mut value = 0u32;
        let mut bytes = 4;
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &Address::new(key, GLOBAL),
                0,
                ptr::null(),
                &mut bytes,
                (&mut value as *mut u32).cast(),
            )
        };
        if status == 0 && bytes == 4 {
            Ok(value)
        } else {
            Err(ERROR)
        }
    }
    fn cf_value(id: u32, key: &[u8; 4]) -> Result<CFType, &'static str> {
        let mut value: *const c_void = ptr::null();
        let mut bytes = size_of::<*const c_void>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &Address::new(key, GLOBAL),
                0,
                ptr::null(),
                &mut bytes,
                (&mut value as *mut *const c_void).cast(),
            )
        };
        if status != 0 || bytes as usize != size_of::<*const c_void>() || value.is_null() {
            return Err(ERROR);
        }
        // CoreAudio CF property values follow the create rule (AudioHardwareBase.h).
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }
    fn cf_string(value: CFType) -> Result<String, &'static str> {
        let s = value.downcast_into::<CFString>().ok_or(ERROR)?;
        if s.char_len() > 1024 {
            return Err(ERROR);
        }
        Ok(s.to_string())
    }
    fn ids() -> Result<Vec<u32>, &'static str> {
        let address = Address::new(b"dev#", GLOBAL);
        let mut bytes = 0;
        if unsafe { AudioObjectGetPropertyDataSize(1, &address, 0, ptr::null(), &mut bytes) } != 0
            || bytes == 0
            || bytes > 4096
            || bytes % 4 != 0
        {
            return Err(ERROR);
        }
        let mut ids = vec![0u32; (bytes / 4) as usize];
        let capacity = bytes;
        if unsafe {
            AudioObjectGetPropertyData(
                1,
                &address,
                0,
                ptr::null(),
                &mut bytes,
                ids.as_mut_ptr().cast(),
            )
        } != 0
            || bytes > capacity
            || bytes % 4 != 0
        {
            return Err(ERROR);
        }
        ids.truncate((bytes / 4) as usize);
        Ok(ids)
    }
    fn channels(id: u32, scope: &[u8; 4]) -> Result<u32, &'static str> {
        let address = Address::new(b"slay", u32::from_be_bytes(*scope));
        let mut bytes = 0;
        if unsafe { AudioObjectGetPropertyDataSize(id, &address, 0, ptr::null(), &mut bytes) } != 0
            || bytes < 8
            || bytes > 4096
        {
            return Err(ERROR);
        }
        // u64 storage preserves AudioBuffer's pointer alignment on both Mac architectures.
        let mut storage = vec![0u64; (bytes as usize).div_ceil(8)];
        let capacity = bytes;
        if unsafe {
            AudioObjectGetPropertyData(
                id,
                &address,
                0,
                ptr::null(),
                &mut bytes,
                storage.as_mut_ptr().cast(),
            )
        } != 0
            || bytes > capacity
        {
            return Err(ERROR);
        }
        let count = storage[0] as u32 as usize;
        let offset = (size_of::<u32>() + align_of::<Buffer>() - 1) & !(align_of::<Buffer>() - 1);
        if count > 32 || offset + count * size_of::<Buffer>() > bytes as usize {
            return Err(ERROR);
        }
        let mut channels = 0u32;
        for i in 0..count {
            let buffer = unsafe {
                &*storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset + i * size_of::<Buffer>())
                    .cast::<Buffer>()
            };
            channels = channels
                .checked_add(buffer.channels)
                .filter(|n| *n <= 256)
                .ok_or(ERROR)?;
        }
        Ok(channels)
    }
    pub(super) struct CoreAudio;
    impl Backend for CoreAudio {
        fn devices(&self) -> Result<Vec<Device>, &'static str> {
            let mut devices = Vec::new();
            for id in ids()? {
                let name = cf_string(cf_value(id, b"lnam")?)?;
                if !matches!(
                    name.as_str(),
                    "BlackHole 2ch" | "BlackHole 16ch" | INPUT_NAME | OUTPUT_NAME
                ) {
                    continue;
                }
                let transport = scalar(id, b"tran")?;
                let sources = if transport == AGGREGATE {
                    let array = cf_value(id, b"grup")?
                        .downcast_into::<CFArray>()
                        .ok_or(ERROR)?;
                    if !(0..=32).contains(&array.len()) {
                        return Err(ERROR);
                    }
                    let mut result = Vec::new();
                    for value in array.iter() {
                        result.push(cf_string(unsafe { CFType::wrap_under_get_rule(*value) })?);
                    }
                    result
                } else {
                    Vec::new()
                };
                devices.push(Device {
                    id,
                    name,
                    uid: cf_string(cf_value(id, b"uid ")?)?,
                    transport,
                    inputs: channels(id, b"inpt")?,
                    outputs: channels(id, b"outp")?,
                    sources,
                });
            }
            Ok(devices)
        }
        fn defaults(&self) -> Result<[u32; 3], &'static str> {
            Ok([
                scalar(1, b"dIn ")?,
                scalar(1, b"dOut")?,
                scalar(1, b"sOut")?,
            ])
        }
        fn owner_alive(&self, pid: u32) -> bool {
            if pid == 0 || pid > i32::MAX as u32 {
                return true;
            }
            (unsafe { kill(pid as i32, 0) }) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(3)
        }
        fn create(&self, name: &str, uid: &str, source: &Device) -> Result<u32, &'static str> {
            let string = |s: &str| CFString::new(s).as_CFType();
            let sub = CFDictionary::from_CFType_pairs(&[(string("uid"), string(&source.uid))]);
            let subs = CFArray::from_CFTypes(&[sub.as_CFType()]);
            let spec = CFDictionary::from_CFType_pairs(&[
                (string("name"), string(name)),
                (string("uid"), string(uid)),
                (string("subdevices"), subs.as_CFType()),
                (string("master"), string(&source.uid)),
                (string("private"), CFNumber::from(0).as_CFType()),
                (string("stacked"), CFNumber::from(0).as_CFType()),
            ]);
            let mut id = 0;
            let status =
                unsafe { AudioHardwareCreateAggregateDevice(spec.as_concrete_TypeRef(), &mut id) };
            if status == 0 && id != 0 {
                Ok(id)
            } else {
                Err(ERROR)
            }
        }
        fn destroy(&self, id: u32) -> Result<(), &'static str> {
            if unsafe { AudioHardwareDestroyAggregateDevice(id) } == 0 {
                Ok(())
            } else {
                Err(ERROR)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    };
    struct Fake {
        devices: Mutex<Vec<Device>>,
        creates: AtomicUsize,
        fail_on: AtomicUsize,
        incomplete: AtomicBool,
        change_defaults: AtomicBool,
        alive: Mutex<Vec<u32>>,
        delayed: AtomicBool,
        failures: AtomicUsize,
        pending: Mutex<std::collections::BTreeMap<u32, u8>>,
    }
    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                devices: Mutex::new(vec![
                    Device {
                        id: 2,
                        name: "BlackHole 2ch".into(),
                        uid: "fixture-two".into(),
                        transport: VIRTUAL,
                        inputs: 2,
                        outputs: 2,
                        sources: vec![],
                    },
                    Device {
                        id: 16,
                        name: "BlackHole 16ch".into(),
                        uid: "fixture-sixteen".into(),
                        transport: VIRTUAL,
                        inputs: 16,
                        outputs: 16,
                        sources: vec![],
                    },
                ]),
                creates: AtomicUsize::new(0),
                fail_on: AtomicUsize::new(0),
                incomplete: AtomicBool::new(false),
                change_defaults: AtomicBool::new(false),
                alive: Mutex::new(vec![]),
                delayed: AtomicBool::new(false),
                failures: AtomicUsize::new(0),
                pending: Mutex::new(Default::default()),
            })
        }
    }
    impl Backend for Fake {
        fn devices(&self) -> Result<Vec<Device>, &'static str> {
            if self
                .failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err(ERROR);
            }
            let mut pending = self.pending.lock().unwrap();
            let mut devices = self.devices.lock().unwrap();
            pending.retain(|id, reads| {
                *reads -= 1;
                if *reads == 0 {
                    devices.retain(|d| d.id != *id);
                    false
                } else {
                    true
                }
            });
            Ok(devices.clone())
        }
        fn defaults(&self) -> Result<[u32; 3], &'static str> {
            Ok(
                if self.change_defaults.load(Ordering::SeqCst)
                    && self.creates.load(Ordering::SeqCst) > 0
                {
                    [9, 9, 9]
                } else {
                    [1, 1, 1]
                },
            )
        }
        fn owner_alive(&self, pid: u32) -> bool {
            self.alive.lock().unwrap().contains(&pid)
        }
        fn create(&self, name: &str, uid: &str, source: &Device) -> Result<u32, &'static str> {
            let n = self.creates.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_on.load(Ordering::SeqCst) == n {
                return Err(ERROR);
            }
            let mut ds = self.devices.lock().unwrap();
            let id = 100 + ds.len() as u32;
            ds.push(Device {
                id,
                name: name.into(),
                uid: uid.into(),
                transport: AGGREGATE,
                inputs: if self.incomplete.load(Ordering::SeqCst) {
                    0
                } else {
                    source.inputs
                },
                outputs: source.outputs,
                sources: vec![source.uid.clone()],
            });
            Ok(id)
        }
        fn destroy(&self, id: u32) -> Result<(), &'static str> {
            if self.delayed.load(Ordering::SeqCst) {
                self.pending.lock().unwrap().insert(id, 3);
                self.failures.store(1, Ordering::SeqCst);
            } else {
                self.devices.lock().unwrap().retain(|d| d.id != id);
            }
            Ok(())
        }
    }
    #[test]
    fn aggregate_lease_creates_distinct_virtual_only_routes_and_cleans_owned_devices() {
        let backend = Fake::new();
        let lease = Lease::acquire_with(backend.clone()).expect("two owned aggregates");
        assert_ne!(lease.routes().input_id, lease.routes().output_id);
        let devices = backend.devices().unwrap();
        let tx = devices
            .iter()
            .find(|d| d.id == lease.routes().input_id)
            .unwrap();
        let rx = devices
            .iter()
            .find(|d| d.id == lease.routes().output_id)
            .unwrap();
        assert_eq!(
            (&*tx.name, &tx.sources),
            (INPUT_NAME, &vec!["fixture-two".to_string()])
        );
        assert_eq!(
            (&*rx.name, &rx.sources),
            (OUTPUT_NAME, &vec!["fixture-sixteen".to_string()])
        );
        drop(lease);
        assert_eq!(backend.devices().unwrap().len(), 2);
        assert_eq!(backend.defaults().unwrap(), [1, 1, 1]);
    }
    fn stale() -> Device {
        Device {
            id: 99,
            name: INPUT_NAME.into(),
            uid: format!("{PREFIX}tx.77.0800d31a-21e6-47d2-9550-06d83f783c1f"),
            transport: AGGREGATE,
            inputs: 2,
            outputs: 2,
            sources: vec!["fixture-two".into()],
        }
    }
    #[test]
    fn crashed_owned_aggregate_is_recovered_before_reacquiring() {
        let backend = Fake::new();
        backend.devices.lock().unwrap().push(stale());
        let lease = Lease::acquire_with(backend.clone()).expect("recover exact owned stale route");
        assert!(!backend.devices().unwrap().iter().any(|d| d.id == 99));
        drop(lease);
        assert_eq!(backend.devices().unwrap().len(), 2);
    }
    #[test]
    fn asynchronous_destruction_and_transient_coreaudio_reads_finish_before_immediate_retry() {
        let backend = Fake::new();
        backend.delayed.store(true, Ordering::SeqCst);
        backend.alive.lock().unwrap().push(std::process::id());
        let lease = Lease::acquire_with(backend.clone()).unwrap();
        drop(lease);
        assert_eq!(
            backend.devices().unwrap().len(),
            2,
            "all owned devices retired before stop returns"
        );
        let second = Lease::acquire_with(backend.clone())
            .expect("no retiring live-owner route blocks retry");
        drop(second);
    }
    #[test]
    fn failed_second_creation_and_incomplete_device_publication_roll_back_without_touching_sources()
    {
        for incomplete in [false, true] {
            let backend = Fake::new();
            if incomplete {
                backend.incomplete.store(true, Ordering::SeqCst);
            } else {
                backend.fail_on.store(2, Ordering::SeqCst);
            }
            assert!(Lease::acquire_with(backend.clone()).is_err());
            assert_eq!(
                backend.devices().unwrap().len(),
                2,
                "no created route remains"
            );
        }
    }
    #[test]
    fn live_foreign_reconfigured_and_invalid_source_devices_are_never_reclaimed() {
        for case in 0..7 {
            let backend = Fake::new();
            let mut d = stale();
            match case {
                0 => backend.alive.lock().unwrap().push(77),
                1 => d.uid = "foreign-device".into(),
                2 => d.sources = vec!["physical-microphone".into()],
                3 => d.transport = VIRTUAL,
                4 => d.uid = format!("{PREFIX}tx.0.0800d31a-21e6-47d2-9550-06d83f783c1f"),
                5 => d.uid = format!("{PREFIX}tx.77.not-a-uuid"),
                _ => d.sources.push("physical-speaker".into()),
            }
            backend.devices.lock().unwrap().push(d);
            let before = backend.devices().unwrap();
            assert!(Lease::acquire_with(backend.clone()).is_err());
            assert_eq!(backend.devices().unwrap(), before);
        }
        for case in 0..5 {
            let backend = Fake::new();
            {
                let mut ds = backend.devices.lock().unwrap();
                match case {
                    0 => {
                        let d = ds[0].clone();
                        ds.push(d);
                    }
                    1 => ds[0].transport = AGGREGATE,
                    2 => ds[0].inputs = 0,
                    3 => ds[0].uid.clear(),
                    _ => ds[1].uid = ds[0].uid.clone(),
                }
            }
            let before = backend.devices().unwrap();
            assert!(Lease::acquire_with(backend.clone()).is_err());
            assert_eq!(backend.devices().unwrap(), before);
        }
    }
    #[test]
    fn changed_defaults_abort_without_overwriting_the_users_new_defaults_and_drop_preserves_reconfigured_devices(
    ) {
        let backend = Fake::new();
        backend.change_defaults.store(true, Ordering::SeqCst);
        assert!(Lease::acquire_with(backend.clone()).is_err());
        assert_eq!(backend.defaults().unwrap(), [9, 9, 9]);
        assert_eq!(backend.devices().unwrap().len(), 2);
        let backend = Fake::new();
        let lease = Lease::acquire_with(backend.clone()).unwrap();
        let id = lease.routes().input_id;
        backend
            .devices
            .lock()
            .unwrap()
            .iter_mut()
            .find(|d| d.id == id)
            .unwrap()
            .sources = vec!["physical-mic".into()];
        drop(lease);
        assert_eq!(backend.devices().unwrap().len(), 3);
        assert!(backend.devices().unwrap().iter().any(|d| d.id == id));
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires installed BlackHole 2ch/16ch; creates and destroys two public aggregates"]
    fn native_aggregate_lease_smoke() {
        let backend = native::CoreAudio;
        let defaults = backend.defaults().expect("native defaults snapshot");
        let lease = Lease::acquire().expect("native aggregate routes");
        assert_ne!(lease.routes().input_id, lease.routes().output_id);
        assert!(lease.routes().input_id > 0 && lease.routes().output_id > 0);
        drop(lease);
        let second = Lease::acquire().expect("cleaned routes can be acquired again");
        drop(second);
        assert_eq!(
            backend.defaults().unwrap(),
            defaults,
            "never change system defaults"
        );
        assert!(
            !snapshot_ready(&backend)
                .unwrap()
                .iter()
                .any(|d| matches!(d.name.as_str(), INPUT_NAME | OUTPUT_NAME)),
            "no owned aggregate remains"
        );
    }
}
