#[cfg(windows)]
pub(super) struct ProcessGroup {
    _handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl ProcessGroup {
    pub fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        // The job closes with this owner, including when Windows terminates the desktop process.
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let handle = std::os::windows::io::OwnedHandle::from_raw_handle(raw);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let process = child
                .raw_handle()
                .ok_or_else(|| std::io::Error::other("provider process handle is unavailable"))?;
            if AssignProcessToJobObject(handle.as_raw_handle(), process) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self { _handle: handle })
        }
    }
}

#[cfg(not(windows))]
pub(super) struct ProcessGroup;
#[cfg(not(windows))]
impl ProcessGroup {
    pub fn attach(_child: &tokio::process::Child) -> std::io::Result<Self> {
        Ok(Self)
    }
}
