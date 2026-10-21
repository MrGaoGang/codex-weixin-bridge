const dialog = document.querySelector("#passwordLoginDialog");
const form = document.querySelector("#passwordLoginForm");
const password = document.querySelector("#password");
const error = document.querySelector("#loginError");
const submit = document.querySelector("#loginSubmit");
dialog.addEventListener("cancel", (event) => event.preventDefault());
dialog.showModal();
document.querySelector("#togglePassword").addEventListener("click", (event) => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  event.currentTarget.textContent = visible ? "隐藏" : "显示";
  event.currentTarget.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  event.currentTarget.setAttribute("aria-pressed", String(visible));
});
form.addEventListener("input", () => {
  error.textContent = "";
  password.removeAttribute("aria-invalid");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  error.textContent = "";
  submit.disabled = true;
  submit.firstElementChild.textContent = "正在登录…";
  form.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ username: form.elements.username.value, password: password.value })
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(response.status === 401 ? "用户名或密码不正确，请重新输入。" : result.error || "暂时无法登录，请稍后重试。");
    }
    password.value = "";
    window.location.replace(`/${window.location.hash}`);
  } catch (reason) {
    error.textContent = reason instanceof TypeError ? "连接失败，请检查网络后重试。" : reason.message;
    password.setAttribute("aria-invalid", "true");
    password.focus();
    submit.disabled = false;
    submit.firstElementChild.textContent = "登录管理页";
    form.removeAttribute("aria-busy");
  }
});
