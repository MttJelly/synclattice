import { createApp, h, reactive, shallowReactive } from "../../node_modules/vue/dist/vue.runtime.esm-browser.prod.js";
import { render } from "./vue-render.generated.js";

const root = document.querySelector("#app");
root.replaceChildren();

const savedTheme = ["system", "light", "dark"].includes(localStorage.getItem("chatswitch-theme"))
  ? localStorage.getItem("chatswitch-theme")
  : "system";
const resolvedTheme = savedTheme === "system"
  ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  : savedTheme;
document.documentElement.dataset.theme = resolvedTheme;
document.documentElement.style.colorScheme = resolvedTheme;
window.chatSwitch.setWindowTheme(resolvedTheme);

const attachmentUi = reactive({
  items: [],
  dragActive: false,
});
const confirmationUi = reactive({
  open: false,
  eyebrow: "请确认",
  title: "确认操作？",
  description: "",
  detail: "",
  confirmLabel: "确认",
  cancelLabel: "取消",
  tone: "danger",
});
window.ChatSwitchVueRuntime = { shallowReactive, attachmentUi, confirmationUi };

const AttachmentTray = {
  name: "AttachmentTray",
  setup() {
    const remove = (index) => window.dispatchEvent(new CustomEvent("chatswitch:remove-attachment", {
      detail: { index },
    }));
    const copy = (item) => window.dispatchEvent(new CustomEvent("chatswitch:copy-attachment", {
      detail: { path: item.path },
    }));
    const open = (item) => window.dispatchEvent(new CustomEvent("chatswitch:preview-attachment", {
      detail: { path: item.path },
    }));
    return () => h("div", {
      id: "attachment-list",
      class: ["attachment-list", { hidden: attachmentUi.items.length === 0 }],
      "aria-label": "待发送附件",
    }, attachmentUi.items.map((item, index) => h("div", {
      class: "attachment-item",
      key: item.path,
    }, [
      item.isImage
        ? h("img", { src: item.url, alt: `待发送图片 ${index + 1}` })
        : h("span", { class: "attachment-file-icon", "aria-hidden": "true" }, item.extension || "FILE"),
      h("span", { class: "attachment-copy" }, [
        h("strong", { title: item.name }, item.name),
        h("small", null, item.typeLabel),
      ]),
      h("button", {
        type: "button",
        class: "attachment-copy-button",
        title: item.isImage ? `复制 ${item.name}` : `预览 ${item.name}`,
        "aria-label": item.isImage ? `复制 ${item.name}` : `预览 ${item.name}`,
        onClick: () => (item.isImage ? copy(item) : open(item)),
      }, [h("span", { "aria-hidden": "true" }, item.isImage ? "⧉" : "⌕")]),
      h("button", {
        type: "button",
        class: "attachment-remove",
        title: `移除 ${item.name}`,
        "aria-label": `移除 ${item.name}`,
        onClick: () => remove(index),
      }, [h("span", { "aria-hidden": "true" }, "×")]),
    ])));
  },
};

const AttachmentDropOverlay = {
  name: "AttachmentDropOverlay",
  setup() {
    return () => h("div", {
      id: "attachment-drop-overlay",
      class: ["attachment-drop-overlay", { hidden: !attachmentUi.dragActive }],
      role: "status",
      "aria-live": "polite",
    }, [
      h("div", { class: "attachment-drop-content" }, [
        h("span", { class: "attachment-drop-symbol", "aria-hidden": "true" }, "+"),
        h("strong", null, "释放以添加附件"),
        h("small", null, "图片、PDF、Word、Excel、PPT 或文本，最多 8 个"),
      ]),
    ]);
  },
};

const AppConfirmationDialog = {
  name: "AppConfirmationDialog",
  setup() {
    const decide = (confirmed) => window.dispatchEvent(new CustomEvent("chatswitch:confirmation-decision", {
      detail: { confirmed },
    }));
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        decide(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [document.querySelector("#confirmation-cancel"), document.querySelector("#confirmation-confirm")]
        .filter(Boolean);
      const index = controls.indexOf(document.activeElement);
      if (!controls.length) return;
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    };
    return () => h("div", {
      id: "confirmation-overlay",
      class: ["overlay", "app-confirm-overlay", { hidden: !confirmationUi.open }],
      onClick: (event) => {
        if (event.target === event.currentTarget) decide(false);
      },
      onKeydown,
    }, [
      h("section", {
        class: ["app-confirm-dialog", `tone-${confirmationUi.tone}`],
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "confirmation-title",
        "aria-describedby": confirmationUi.detail
          ? "confirmation-description confirmation-detail"
          : "confirmation-description",
      }, [
        h("div", { class: "app-confirm-icon", "aria-hidden": "true" }, [
          h("span", { class: "app-confirm-glyph" }, confirmationUi.tone === "danger" ? "!" : "i"),
        ]),
        h("div", { class: "app-confirm-copy" }, [
          h("span", { class: "app-confirm-eyebrow" }, confirmationUi.eyebrow),
          h("h2", { id: "confirmation-title" }, confirmationUi.title),
          h("p", { id: "confirmation-description" }, confirmationUi.description),
        ]),
        confirmationUi.detail
          ? h("div", { id: "confirmation-detail", class: "app-confirm-detail" }, confirmationUi.detail)
          : null,
        h("div", { class: "app-confirm-actions" }, [
          h("button", {
            id: "confirmation-cancel",
            class: "secondary-command",
            type: "button",
            onClick: () => decide(false),
          }, confirmationUi.cancelLabel),
          h("button", {
            id: "confirmation-confirm",
            class: ["primary-command", "app-confirm-primary"],
            type: "button",
            onClick: () => decide(true),
          }, confirmationUi.confirmLabel),
        ]),
      ]),
    ]);
  },
};

const vueApp = createApp({
  name: "ChatSwitchApp",
  components: { AttachmentTray, AttachmentDropOverlay, AppConfirmationDialog },
  render,
  async mounted() {
    try {
      await new Promise((resolve, reject) => {
        const controller = document.createElement("script");
        controller.src = "app.js";
        controller.addEventListener("load", resolve, { once: true });
        controller.addEventListener("error", () => reject(new Error("无法加载 ChatSwitch 业务控制器。")), { once: true });
        document.body.appendChild(controller);
      });
      root.classList.remove("vue-pending");
      root.classList.add("vue-ready");
    } catch (error) {
      root.classList.remove("vue-pending");
        root.innerHTML = `<main class="renderer-fatal" role="alert"><strong>ChatSwitch 界面初始化失败</strong><span></span></main>`;
      root.querySelector("span").textContent = error?.message || String(error);
      console.error(error);
    }
  },
});

vueApp.config.errorHandler = (error) => {
  console.error("[vue]", error);
};
vueApp.mount(root);
window.chatSwitchVue = vueApp;
