import usePlantPhoto from '../hooks/usePlantPhoto';
import { isHttpPhotoUrl } from '../utils/photoUrl';

export default function PlantPhoto({ plant, className, alt = plant.name }) {
  const { src, failed, retry, onError, revision } = usePlantPhoto(plant);
  const isExternal = !plant.photoKey && isHttpPhotoUrl(plant.photo);
  return <>
    {src && (!failed || plant.photoKey) && <img key={`${src}-${revision}`} className={className} src={src} alt={alt} onError={onError} />}
    {failed && <span className='formError' role='status'>Не удалось загрузить фото. {isExternal && 'Изображение недоступно или сайт запрещает его показ. '}<button type='button' className='btn' onClick={retry}>Повторить</button></span>}
  </>;
}
