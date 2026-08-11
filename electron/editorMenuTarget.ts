export type EditorMenuChannel =
	| "menu-load-project"
	| "menu-save-project"
	| "menu-save-project-as"
	| "menu-new-project";

export interface EditorMenuWindow {
	isDestroyed: () => boolean;
	webContents: {
		getURL: () => string;
		isLoadingMainFrame: () => boolean;
		send: (channel: string) => void;
		once: (event: "did-finish-load", listener: () => void) => void;
	};
}

function isLiveEditorWindow(window: EditorMenuWindow | null): window is EditorMenuWindow {
	return (
		window !== null &&
		!window.isDestroyed() &&
		window.webContents.getURL().includes("windowType=editor")
	);
}

function sendWhenReady(window: EditorMenuWindow, channel: EditorMenuChannel) {
	if (window.isDestroyed()) return;

	if (!window.webContents.isLoadingMainFrame()) {
		window.webContents.send(channel);
		return;
	}

	window.webContents.once("did-finish-load", () => {
		if (window.isDestroyed()) return;
		window.webContents.send(channel);
	});
}

export function dispatchEditorMenuAction(
	channel: EditorMenuChannel,
	focusedWindow: EditorMenuWindow | null,
	mainWindow: EditorMenuWindow | null,
	createEditorWindow: () => EditorMenuWindow | null,
) {
	const existingEditor = isLiveEditorWindow(focusedWindow)
		? focusedWindow
		: isLiveEditorWindow(mainWindow)
			? mainWindow
			: null;

	if (existingEditor) {
		sendWhenReady(existingEditor, channel);
		return;
	}

	const createdEditor = createEditorWindow();
	if (!createdEditor) return;

	sendWhenReady(createdEditor, channel);
}
