"""ORM 模型汇总。导入本包即可注册全部表。"""
from app.db.session import Base
from app.models.asset import Asset, UploadSession
from app.models.asset_folder import AssetFolder
from app.models.project import Project
from app.models.version import ProjectVersion

__all__ = ["Base", "Project", "Asset", "UploadSession", "AssetFolder", "ProjectVersion"]
