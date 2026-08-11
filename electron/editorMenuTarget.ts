export type EditorMenuChannel =
	| "menu-load-project"
	| "menu-save-project"
	| "menu-save-project-as"
	| "menu-new-project";

export interface EditorMenuWindow {
	isDestroyed: () => boolean;
	webContents: {
		getURL: () => string;
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
		existingEditor.webContents.send(channel);
		return;
	}

	const createdEditor = createEditorWindow();
	if (!createdEditor || createdEditor.isDestroyed()) return;

	createdEditor.webContents.once("did-finish-load", () => {
		if (createdEditor.isDestroyed()) return;
		createdEditor.webContents.send(channel);
	});
}
