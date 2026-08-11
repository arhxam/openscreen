import { describe, expect, it, vi } from "vitest";
import { dispatchEditorMenuAction, type EditorMenuWindow } from "./editorMenuTarget";

type FakeWindow = EditorMenuWindow & {
	emitDidFinishLoad: () => void;
	send: ReturnType<typeof vi.fn>;
};

function createWindow(options: { editor?: boolean; destroyed?: boolean } = {}): FakeWindow {
	const send = vi.fn();
	let didFinishLoad: (() => void) | undefined;

	return {
		isDestroyed: () => options.destroyed ?? false,
		webContents: {
			getURL: () =>
				options.editor === false
					? "file:///index.html?windowType=notes"
					: "file:///index.html?windowType=editor",
			send,
			once: (event, listener) => {
				expect(event).toBe("did-finish-load");
				didFinishLoad = listener;
			},
		},
		emitDidFinishLoad: () => didFinishLoad?.(),
		send,
	};
}

describe("dispatchEditorMenuAction", () => {
	it("sends immediately to a live focused editor", () => {
		const focused = createWindow();
		const main = createWindow();
		const createEditor = vi.fn();

		dispatchEditorMenuAction("menu-save-project", focused, main, createEditor);

		expect(focused.send).toHaveBeenCalledWith("menu-save-project");
		expect(main.send).not.toHaveBeenCalled();
		expect(createEditor).not.toHaveBeenCalled();
	});

	it("uses the live main editor when an auxiliary window is focused", () => {
		const auxiliary = createWindow({ editor: false });
		const main = createWindow();
		const createEditor = vi.fn();

		dispatchEditorMenuAction("menu-save-project", auxiliary, main, createEditor);

		expect(main.send).toHaveBeenCalledWith("menu-save-project");
		expect(auxiliary.send).not.toHaveBeenCalled();
		// The real creator closes the old main window, so not calling it verifies that
		// the auxiliary-focus path cannot enter the force-close path.
		expect(createEditor).not.toHaveBeenCalled();
	});

	it.each([
		["destroyed", createWindow({ destroyed: true })],
		["non-editor", createWindow({ editor: false })],
	])("creates an editor when the main window is %s", (_label, main) => {
		const created = createWindow();
		const createEditor = vi.fn(() => created);

		dispatchEditorMenuAction("menu-new-project", null, main, createEditor);

		expect(createEditor).toHaveBeenCalledOnce();
		expect(created.send).not.toHaveBeenCalled();
		created.emitDidFinishLoad();
		expect(created.send).toHaveBeenCalledWith("menu-new-project");
	});

	it("creates an editor when no window exists", () => {
		const created = createWindow();
		const createEditor = vi.fn(() => created);

		dispatchEditorMenuAction("menu-load-project", null, null, createEditor);

		expect(createEditor).toHaveBeenCalledOnce();
		created.emitDidFinishLoad();
		expect(created.send).toHaveBeenCalledWith("menu-load-project");
	});

	it("keeps the created window as the async action target", () => {
		const created = createWindow();
		const replacement = createWindow();
		let currentWindow = created;

		dispatchEditorMenuAction("menu-save-project-as", null, null, () => currentWindow);
		currentWindow = replacement;
		created.emitDidFinishLoad();

		expect(created.send).toHaveBeenCalledWith("menu-save-project-as");
		expect(replacement.send).not.toHaveBeenCalled();
	});

	it("does not send after a newly created target is destroyed", () => {
		let destroyed = false;
		const created = createWindow();
		created.isDestroyed = () => destroyed;

		dispatchEditorMenuAction("menu-save-project", null, null, () => created);
		destroyed = true;
		created.emitDidFinishLoad();

		expect(created.send).not.toHaveBeenCalled();
	});
});
