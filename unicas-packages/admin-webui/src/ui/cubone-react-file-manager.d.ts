declare module "@cubone/react-file-manager/dist/react-file-manager.es.js" {
  import type { CSSProperties, ComponentType, ReactNode } from "react";

  export interface FileManagerFile {
    readonly name: string;
    readonly isDirectory: boolean;
    readonly path: string;
    readonly updatedAt?: string;
    readonly size?: number;
  }

  export interface FileManagerProps {
    readonly files: readonly FileManagerFile[];
    readonly className?: string;
    readonly height?: string | number;
    readonly width?: string | number;
    readonly initialPath?: string;
    readonly isLoading?: boolean;
    readonly layout?: "list" | "grid";
    readonly language?: string;
    readonly primaryColor?: string;
    readonly fontFamily?: string;
    readonly style?: CSSProperties;
    readonly enableFilePreview?: boolean;
    readonly collapsibleNav?: boolean;
    readonly defaultNavExpanded?: boolean;
    readonly permissions?: {
      readonly create?: boolean;
      readonly upload?: boolean;
      readonly move?: boolean;
      readonly copy?: boolean;
      readonly rename?: boolean;
      readonly download?: boolean;
      readonly delete?: boolean;
    };
    readonly filePreviewComponent?: (file: FileManagerFile) => ReactNode;
    readonly onCreateFolder?: (name: string, parentFolder: FileManagerFile) => void;
    readonly onDelete?: (files: FileManagerFile[]) => void;
    readonly onDownload?: (files: FileManagerFile[]) => void;
    readonly onFileOpen?: (file: FileManagerFile) => void;
    readonly onFolderChange?: (path: string) => void;
    readonly onPaste?: (files: FileManagerFile[], destinationFolder: FileManagerFile, operationType: "copy" | "move") => void;
    readonly onRefresh?: () => void;
    readonly onRename?: (file: FileManagerFile, newName: string) => void;
  }

  export const FileManager: ComponentType<FileManagerProps>;
}
